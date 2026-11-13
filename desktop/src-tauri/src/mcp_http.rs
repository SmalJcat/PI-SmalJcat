//! Streamable HTTP using the system curl. No user configuration is modified.
use crate::rpc::hide_console;
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::watch,
    task::JoinHandle,
};

const MAX_LINE: usize = 1024 * 1024;
const MAX_BODY: usize = 4 * 1024 * 1024;
const MAX_HEADERS: usize = 64 * 1024;
pub(crate) type Notification = Arc<dyn Fn(Value) + Send + Sync>;

pub(crate) struct HttpTransport {
    url: String,
    headers: BTreeMap<String, String>,
    session_id: Mutex<Option<String>>,
    protocol: Mutex<Option<String>>,
    last_event_id: Mutex<Option<String>>,
    closed: watch::Sender<bool>,
    listener: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Default)]
struct Headers {
    status: u16,
    content_type: String,
    session_id: Option<String>,
}
enum Exchange {
    Response(Value),
    Accepted,
    StreamEnded,
    Unsupported,
}

impl HttpTransport {
    pub(crate) fn new(url: &str, headers: BTreeMap<String, String>) -> Result<Arc<Self>> {
        let parsed = url::Url::parse(url).context("MCP HTTP URL 无效")?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            bail!("MCP HTTP 仅支持 http/https URL");
        }
        for (name, value) in &headers {
            if name.is_empty()
                || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                || value.bytes().any(|b| b < 32 || b == 127)
            {
                bail!("MCP HTTP 请求头格式无效");
            }
            if [
                "mcp-session-id",
                "mcp-protocol-version",
                "last-event-id",
                "content-type",
                "accept",
                "content-length",
                "transfer-encoding",
                "host",
            ]
            .contains(&name.to_ascii_lowercase().as_str())
            {
                bail!("MCP HTTP 协议请求头由客户端管理：{name}");
            }
        }
        let (closed, _) = watch::channel(false);
        Ok(Arc::new(Self {
            url: url.to_owned(),
            headers,
            session_id: Mutex::new(None),
            protocol: Mutex::new(None),
            last_event_id: Mutex::new(None),
            closed,
            listener: Mutex::new(None),
        }))
    }
    pub(crate) fn connected(&self) -> bool {
        !*self.closed.borrow()
    }
    pub(crate) fn set_protocol(&self, protocol: &str) -> Result<()> {
        if !["2024-11-05", "2025-03-26", "2025-06-18"].contains(&protocol) {
            bail!("服务器返回不支持的 MCP 协议版本");
        }
        *self.protocol.lock().unwrap() = Some(protocol.to_owned());
        Ok(())
    }
    pub(crate) async fn post(
        &self,
        payload: &Value,
        timeout: Duration,
        notify: &Notification,
    ) -> Result<Value> {
        self.post_guarded(payload, timeout, notify, None).await
    }

    pub(crate) async fn post_guarded(
        &self,
        payload: &Value,
        timeout: Duration,
        notify: &Notification,
        permit: Option<&std::sync::atomic::AtomicBool>,
    ) -> Result<Value> {
        let mut closed = self.closed.subscribe();
        if *closed.borrow() {
            bail!("MCP HTTP 会话已关闭或过期，请断开后重新连接");
        }
        let result = tokio::select! {
            _ = closed.changed() => bail!("MCP HTTP 会话已关闭或过期，请断开后重新连接"),
            result = tokio::time::timeout(timeout, self.exchange_guarded("POST", Some(payload), notify, permit)) => result.context("MCP HTTP 请求超时")??,
        };
        match result {
            Exchange::Response(value) => Ok(value),
            Exchange::Accepted if payload.get("id").is_none() => Ok(Value::Null),
            _ => bail!("MCP HTTP 未返回对应请求的 JSON-RPC 响应"),
        }
    }
    // McpSession owns this transport and explicitly stops this task on Drop.
    pub(crate) fn listen(self: &Arc<Self>, notify: Notification) {
        let transport = self.clone();
        let mut closed = self.closed.subscribe();
        let task = tokio::spawn(async move {
            let mut delay = 1;
            loop {
                if *closed.borrow() {
                    break;
                }
                let result = tokio::select! {
                    _ = closed.changed() => break,
                    result = transport.exchange("GET", None, &notify) => result,
                };
                if matches!(result, Ok(Exchange::Unsupported)) || !transport.connected() {
                    break;
                }
                // A broken stream may have missed a tool list notification.
                notify(
                    serde_json::json!({"jsonrpc":"2.0","method":"notifications/tools/list_changed"}),
                );
                notify(
                    serde_json::json!({"jsonrpc":"2.0","method":"notifications/resources/list_changed"}),
                );
                tokio::select! {
                    _ = closed.changed() => break,
                    _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
                }
                delay = (delay * 2).min(8);
            }
        });
        *self.listener.lock().unwrap() = Some(task);
    }
    pub(crate) fn stop(&self) {
        self.closed.send_replace(true);
        if let Some(task) = self.listener.lock().unwrap().take() {
            task.abort();
        }
    }
    pub(crate) async fn shutdown(&self) {
        self.stop();
        if self.session_id.lock().unwrap().is_some() {
            let ignore: Notification = Arc::new(|_| {});
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                self.exchange("DELETE", None, &ignore),
            )
            .await;
        }
    }
    async fn exchange(
        &self,
        method: &str,
        payload: Option<&Value>,
        notify: &Notification,
    ) -> Result<Exchange> {
        self.exchange_guarded(method, payload, notify, None).await
    }

    async fn exchange_guarded(
        &self,
        method: &str,
        payload: Option<&Value>,
        notify: &Notification,
        permit: Option<&std::sync::atomic::AtomicBool>,
    ) -> Result<Exchange> {
        let mut command = Command::new(crate::update::curl_exe());
        // No curlrc or redirects: session and credential headers stay on this endpoint.
        command.args([
            "--disable",
            "--globoff",
            "--config",
            "-",
            "--silent",
            "--show-error",
            "--no-buffer",
            "--include",
            "--suppress-connect-headers",
            "--connect-timeout",
            "10",
            "--proto",
            "=http,https",
            "--request",
            method,
        ]);
        // URL, headers and body go through stdin, never process argv or a temp file.
        let mut config = curl_option("url", &self.url);
        config += &curl_option(
            "header",
            if method == "GET" {
                "Accept: text/event-stream"
            } else {
                "Accept: application/json, text/event-stream"
            },
        );
        let session_id = self.session_id.lock().unwrap().clone();
        if let Some(id) = &session_id {
            config += &curl_option("header", &format!("Mcp-Session-Id: {id}"));
        }
        if let Some(protocol) = self.protocol.lock().unwrap().as_ref() {
            config += &curl_option("header", &format!("MCP-Protocol-Version: {protocol}"));
        }
        if method == "GET" {
            if let Some(id) = self.last_event_id.lock().unwrap().as_ref() {
                config += &curl_option("header", &format!("Last-Event-ID: {id}"));
            }
        }
        for (name, value) in &self.headers {
            config += &curl_option("header", &format!("{name}: {value}"));
        }
        if let Some(payload) = payload {
            config += &curl_option("header", "Content-Type: application/json");
            config += &curl_option("data-binary", &serde_json::to_string(payload)?);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        hide_console(&mut command);
        if permit.is_some_and(|permit| !permit.load(std::sync::atomic::Ordering::SeqCst)) {
            bail!("App 已关闭");
        }
        let mut child = command.spawn().context("无法启动 MCP HTTP curl 进程")?;
        let mut stdin = child.stdin.take().context("curl stdin 不可用")?;
        stdin.write_all(config.as_bytes()).await?;
        stdin.shutdown().await?;
        drop(stdin);
        let mut reader = BufReader::new(child.stdout.take().context("curl stdout 不可用")?);
        let headers = read_headers(&mut reader).await?;
        if headers.status == 404 && session_id.is_some() {
            self.closed.send_replace(true);
            notify(
                serde_json::json!({"jsonrpc":"2.0","method":"notifications/resources/list_changed"}),
            );
            bail!("MCP HTTP 会话已过期（404），请断开后重新连接；工具调用未自动重试");
        }
        if headers.status == 405 && (method == "GET" || method == "DELETE") {
            return Ok(Exchange::Unsupported);
        }
        if !(200..300).contains(&headers.status) {
            bail!("MCP HTTP 返回状态 {}", headers.status);
        }
        if payload.is_some_and(|value| value["method"] == "initialize") {
            if let Some(id) = headers.session_id {
                if id.is_empty() || id.len() > 1024 || !id.bytes().all(|b| (33..=126).contains(&b))
                {
                    bail!("MCP HTTP 会话标识无效");
                }
                *self.session_id.lock().unwrap() = Some(id);
            }
        }
        let expected = payload.and_then(|value| value.get("id"));
        if method == "DELETE" || (method == "POST" && expected.is_none() && headers.status == 202) {
            return Ok(Exchange::Accepted);
        }
        if headers.status != 200 {
            bail!("MCP HTTP 请求未返回结果（{}）", headers.status);
        }
        if headers.content_type == "application/json" && method == "POST" {
            let mut body = Vec::new();
            reader
                .take((MAX_BODY + 1) as u64)
                .read_to_end(&mut body)
                .await?;
            if body.len() > MAX_BODY {
                bail!("MCP HTTP 响应超过限制");
            }
            if !child.wait().await?.success() {
                bail!("MCP HTTP 响应传输失败");
            }
            let message: Value =
                serde_json::from_slice(&body).context("MCP HTTP 响应不是合法 JSON")?;
            if is_response(&message, expected) {
                return Ok(Exchange::Response(message));
            }
            bail!("MCP HTTP 响应 ID 与请求不符");
        }
        if headers.content_type != "text/event-stream" {
            bail!("MCP HTTP 响应 Content-Type 无效");
        }
        if method == "GET" {
            // Refresh after reconnection too: changes during the gap may not be replayed.
            notify(
                serde_json::json!({"jsonrpc":"2.0","method":"notifications/tools/list_changed"}),
            );
            notify(
                serde_json::json!({"jsonrpc":"2.0","method":"notifications/resources/list_changed"}),
            );
        }
        let mut event = SseEvent::default();
        while let Some(line) = bounded_line(&mut reader, MAX_LINE).await? {
            if event.push(&line)? {
                if let Some(message) = event.message()? {
                    if method == "POST" && is_response(&message, expected) {
                        // Do not wait for EOF: the server can keep the response stream open.
                        let _ = child.start_kill();
                        let _ = child.wait().await;
                        return Ok(Exchange::Response(message));
                    }
                    if message["jsonrpc"] == "2.0"
                        && message.get("id").is_none()
                        && message["method"].as_str().is_some()
                    {
                        notify(message);
                    }
                }
                if method == "GET" {
                    if let Some(id) = event.id.take() {
                        *self.last_event_id.lock().unwrap() =
                            if id.is_empty() { None } else { Some(id) };
                    }
                }
                event = SseEvent::default();
            }
        }
        if !child.wait().await?.success() {
            bail!("MCP HTTP SSE 传输失败");
        }
        if method == "GET" {
            Ok(Exchange::StreamEnded)
        } else {
            bail!("MCP HTTP SSE 在返回匹配响应前结束")
        }
    }
}
fn curl_option(name: &str, value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");
    format!("{name} = \"{escaped}\"\n")
}

fn is_response(message: &Value, expected: Option<&Value>) -> bool {
    expected.is_some()
        && message.get("id") == expected
        && message["jsonrpc"] == "2.0"
        && (message.get("result").is_some() || message.get("error").is_some())
}
async fn bounded_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> Result<Option<String>> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            break;
        }
        let count = buffer
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buffer.len(), |i| i + 1);
        if line.len() + count > limit {
            bail!("MCP HTTP 行超过限制");
        }
        let ended = buffer[count - 1] == b'\n';
        line.extend_from_slice(&buffer[..count]);
        reader.consume(count);
        if ended {
            break;
        }
    }
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(Some(
        String::from_utf8(line).context("MCP HTTP 响应不是 UTF-8")?,
    ))
}
async fn read_headers<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Headers> {
    let mut bytes = 0;
    loop {
        let status = bounded_line(reader, MAX_HEADERS)
            .await?
            .context("MCP HTTP 未返回响应头")?;
        bytes += status.len();
        let mut parts = status.split_whitespace();
        if !parts.next().is_some_and(|value| value.starts_with("HTTP/")) {
            bail!("MCP HTTP 状态行无效");
        }
        let mut headers = Headers {
            status: parts.next().context("MCP HTTP 缺少状态码")?.parse()?,
            ..Default::default()
        };
        loop {
            let line = bounded_line(reader, MAX_HEADERS)
                .await?
                .context("MCP HTTP 响应头不完整")?;
            bytes += line.len() + 2;
            if bytes > MAX_HEADERS {
                bail!("MCP HTTP 响应头超过限制");
            }
            if line.is_empty() {
                break;
            }
            let (name, value) = line.split_once(':').context("MCP HTTP 响应头无效")?;
            match name.to_ascii_lowercase().as_str() {
                "content-type" => {
                    headers.content_type = value
                        .split(';')
                        .next()
                        .unwrap_or_default()
                        .trim()
                        .to_ascii_lowercase()
                }
                "mcp-session-id" => {
                    if headers.session_id.is_some() {
                        bail!("MCP HTTP 返回重复会话标识");
                    }
                    headers.session_id = Some(value.trim().to_owned());
                }
                _ => {}
            }
        }
        if !(100..200).contains(&headers.status) {
            return Ok(headers);
        }
    }
}
#[derive(Default)]
struct SseEvent {
    data: Vec<String>,
    bytes: usize,
    id: Option<String>,
}
impl SseEvent {
    fn push(&mut self, line: &str) -> Result<bool> {
        if line.is_empty() {
            return Ok(true);
        }
        self.bytes += line.len();
        if self.bytes > MAX_BODY {
            bail!("MCP HTTP SSE 事件超过限制");
        }
        let (name, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match name {
            "data" => self.data.push(value.to_owned()),
            "id" if value.len() <= 1024 && value.bytes().all(|b| (32..=126).contains(&b)) => {
                self.id = Some(value.to_owned())
            }
            _ => {}
        }
        Ok(false)
    }
    fn message(&self) -> Result<Option<Value>> {
        if self.data.is_empty() {
            return Ok(None);
        }
        Ok(Some(
            serde_json::from_str(&self.data.join("\n"))
                .context("MCP HTTP SSE data 不是合法 JSON")?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn headers_allow_interim_responses_and_reject_duplicate_sessions() {
        let bytes = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nmCp-SeSsIoN-iD: opaque-id\r\n\r\n";
        let headers = read_headers(&mut &bytes[..]).await.unwrap();
        assert_eq!(headers.status, 200);
        assert_eq!(headers.content_type, "text/event-stream");
        assert_eq!(headers.session_id.as_deref(), Some("opaque-id"));
        let duplicate = b"HTTP/1.1 200 OK\nMcp-Session-Id: a\nmcp-session-id: b\n\n";
        assert!(read_headers(&mut &duplicate[..]).await.is_err());
        let incomplete = b"HTTP/1.1 200 OK\n";
        assert!(read_headers(&mut &incomplete[..]).await.is_err());
    }

    #[tokio::test]
    async fn bounded_lines_preserve_fragmented_unicode_and_enforce_limits() {
        let (mut writer, reader) = tokio::io::duplex(1);
        let task = tokio::spawn(async move {
            writer
                .write_all("data: 你好🙂\r\n".as_bytes())
                .await
                .unwrap();
        });
        assert_eq!(
            bounded_line(&mut BufReader::new(reader), 100)
                .await
                .unwrap()
                .as_deref(),
            Some("data: 你好🙂")
        );
        task.await.unwrap();
        assert!(bounded_line(&mut &b"12345\n"[..], 4).await.is_err());
        assert!(bounded_line(&mut &b"\xff\n"[..], 4).await.is_err());
    }

    #[test]
    fn sse_comments_multiline_data_and_bad_payloads() {
        let mut event = SseEvent::default();
        for line in [
            ": heartbeat",
            "event: message",
            "id: event-1",
            "data: {\"jsonrpc\":\"2.0\",",
            "data: \"id\":1,\"result\":{}}",
        ] {
            assert!(!event.push(line).unwrap());
        }
        assert!(event.push("").unwrap());
        assert_eq!(event.id.as_deref(), Some("event-1"));
        assert!(is_response(
            &event.message().unwrap().unwrap(),
            Some(&serde_json::json!(1))
        ));
        let mut bad = SseEvent::default();
        bad.push("data: not json").unwrap();
        assert!(bad.message().is_err());
        assert!(bad.push(&"x".repeat(MAX_BODY)).is_err());
    }
}
