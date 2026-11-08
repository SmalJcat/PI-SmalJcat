use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{ChildStdin, Command},
    sync::{mpsc, oneshot, watch, Mutex as AsyncMutex},
    time::timeout,
};
use uuid::Uuid;

pub type EventSink = Arc<dyn Fn(Value) + Send + Sync>;
type Reply = oneshot::Sender<std::result::Result<Value, String>>;
const MAX_RECORD: usize = 64 * 1024 * 1024;

#[derive(Default)]
pub struct JsonLines {
    bytes: Vec<u8>,
}
impl JsonLines {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>> {
        let mut values = Vec::new();
        for part in chunk.split_inclusive(|b| *b == b'\n') {
            if self.bytes.len() + part.len() > MAX_RECORD {
                bail!("Pi 单条记录超过 64 MB");
            }
            self.bytes.extend_from_slice(part);
            if part.last() == Some(&b'\n') {
                if !self.bytes.iter().all(u8::is_ascii_whitespace) {
                    values.push(
                        serde_json::from_slice(&self.bytes).context("无法解析 Pi JSONL 记录")?,
                    );
                }
                self.bytes.clear();
            }
        }
        Ok(values)
    }
    pub fn finish(&mut self) -> Result<Vec<Value>> {
        if self.bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Vec::new());
        }
        let result = serde_json::from_slice(&self.bytes).context("Pi 最后一条记录不完整")?;
        self.bytes.clear();
        Ok(vec![result])
    }
}

// Closing the job also terminates grandchildren (MCP workers, shell tools) if the
// desktop process crashes. No system-wide process-name matching is used.
#[cfg(windows)]
pub(crate) struct ProcessJob(isize);
#[cfg(windows)]
impl ProcessJob {
    pub(crate) fn attach(child: &tokio::process::Child) -> Result<Self> {
        use std::mem::{size_of, zeroed};
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(handle);
                return Err(error.into());
            }
            let process = child
                .raw_handle()
                .context("Pi process handle unavailable")?;
            if AssignProcessToJobObject(handle, process as _) == 0 {
                let error = std::io::Error::last_os_error();
                CloseHandle(handle);
                return Err(error.into());
            }
            Ok(Self(handle as isize))
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

pub struct Rpc {
    stdin: AsyncMutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, Reply>>,
    pub busy: AtomicBool,
    pub closed: AtomicBool,
    stopping: AtomicBool,
    stderr: Mutex<Vec<u8>>,
    notifications: Mutex<(u64, std::collections::VecDeque<(u64, Value)>)>,
    shutdown: watch::Sender<bool>,
    exited: watch::Receiver<bool>,
    pub pid: u32,
}
struct PendingGuard {
    rpc: Arc<Rpc>,
    id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.rpc.pending.lock().unwrap().remove(&self.id);
    }
}

impl Rpc {
    pub async fn spawn(
        executable: &Path,
        cwd: &Path,
        prefix: &[String],
        args: &[String],
        sink: EventSink,
        environment: &[(String, String)],
    ) -> Result<Arc<Self>> {
        let mut command = Command::new(executable);
        command
            .args(prefix)
            .args(["--mode", "rpc"])
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env("PI_SKIP_VERSION_CHECK", "1");
        for key in [
            "PI_SESSION_ID",
            "PI_SESSION_FILE",
            "PI_MODEL",
            "PI_PROVIDER",
            "PI_REASONING_LEVEL",
            "ELECTRON_RUN_AS_NODE",
        ] {
            command.env_remove(key);
        }
        for (key, value) in environment {
            command.env(key, value);
        }
        hide_console(&mut command);
        let mut child = command
            .spawn()
            .with_context(|| format!("无法启动 {}", executable.display()))?;
        #[cfg(windows)]
        let mut job = Some(ProcessJob::attach(&child).context("无法创建 Pi 子进程隔离作业")?);
        let pid = child.id().context("Pi PID 不可用")?;
        let stdin = child.stdin.take().context("Pi stdin 不可用")?;
        let mut stdout = child.stdout.take().context("Pi stdout 不可用")?;
        let mut stderr = child.stderr.take().context("Pi stderr 不可用")?;
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let (exit_tx, exited) = watch::channel(false);
        let rpc = Arc::new(Self {
            stdin: AsyncMutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
            busy: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            stderr: Mutex::new(Vec::new()),
            notifications: Mutex::new((0, std::collections::VecDeque::new())),
            shutdown,
            exited,
            pid,
        });
        let (event_tx, mut event_rx) = mpsc::channel::<Value>(256);
        let sink_copy = sink.clone();
        tokio::spawn(async move {
            while let Some(event) = event_rx.recv().await {
                sink_copy(event);
            }
        });
        let reader_rpc = rpc.clone();
        let reader_events = event_tx.clone();
        let mut reader = tokio::spawn(async move {
            let mut parser = JsonLines::default();
            let mut buffer = vec![0; 16 * 1024];
            let result: Result<()> = async {
                loop {
                    let count = stdout.read(&mut buffer).await?;
                    let records = if count == 0 {
                        parser.finish()?
                    } else {
                        parser.push(&buffer[..count])?
                    };
                    for record in records {
                        reader_rpc.receive(record, &reader_events).await;
                    }
                    if count == 0 {
                        break;
                    }
                }
                Ok(())
            }
            .await;
            if let Err(error) = result {
                reader_rpc.fail(&format!("Pi 协议错误：{error}"));
                let _ = reader_events
                    .send(json!({"type":"transport_warning","message":error.to_string()}))
                    .await;
                let _ = reader_rpc.shutdown.send(true);
            }
        });
        let stderr_rpc = rpc.clone();
        let mut stderr_task = tokio::spawn(async move {
            let mut buffer = [0; 4096];
            while let Ok(count) = stderr.read(&mut buffer).await {
                if count == 0 {
                    break;
                }
                let mut tail = stderr_rpc.stderr.lock().unwrap();
                tail.extend_from_slice(&buffer[..count]);
                if tail.len() > 16000 {
                    let excess = tail.len() - 16000;
                    tail.drain(..excess);
                }
            }
        });
        let monitor = rpc.clone();
        tokio::spawn(async move {
            let result = tokio::select! {
                result = child.wait() => result,
                _ = shutdown_rx.changed() => {
                    monitor.stdin.lock().await.take();
                    match timeout(Duration::from_secs(3), child.wait()).await {
                        Ok(result) => result,
                        Err(_) => {
                            #[cfg(windows)]
                            { drop(job.take()); }
                            let _ = child.start_kill();
                            child.wait().await
                        }
                    }
                }
            };
            // The job is dropped here on normal exit too, cleaning any surviving
            // descendants; bounded waits prevent inherited pipes from hanging exit.
            #[cfg(windows)]
            drop(job.take());
            if timeout(Duration::from_secs(2), async {
                let _ = (&mut reader).await;
                let _ = (&mut stderr_task).await;
            })
            .await
            .is_err()
            {
                reader.abort();
                stderr_task.abort();
                monitor.fail("Pi 输出管道未及时关闭");
            }
            let message = if monitor.stopping.load(Ordering::SeqCst) {
                "Pi 已关闭".to_owned()
            } else {
                format!("Pi 进程退出 ({result:?})。{}", monitor.stderr())
            };
            monitor.fail(&message);
            if !monitor.stopping.load(Ordering::SeqCst) {
                let _ = event_tx
                    .send(json!({"type":"transport_exit","message":message}))
                    .await;
            }
            let _ = exit_tx.send(true);
        });
        Ok(rpc)
    }
    async fn receive(&self, record: Value, events: &mpsc::Sender<Value>) {
        let kind = record["type"].as_str().unwrap_or_default();
        if kind == "response" {
            if let Some(id) = record["id"].as_str() {
                if let Some(sender) = self.pending.lock().unwrap().remove(id) {
                    let response = if record["success"].as_bool() == Some(true) {
                        Ok(record["data"].clone())
                    } else {
                        Err(record["error"]
                            .as_str()
                            .unwrap_or("Pi 命令失败")
                            .to_string())
                    };
                    let _ = sender.send(response);
                }
            }
            return;
        }
        if kind == "extension_ui_request" && record["method"] == "notify" {
            let mut notifications = self.notifications.lock().unwrap();
            notifications.0 += 1;
            let sequence = notifications.0;
            notifications.1.push_back((sequence, record.clone()));
            if notifications.1.len() > 100 {
                notifications.1.pop_front();
            }
        }
        if matches!(kind, "agent_start" | "compaction_start") {
            self.busy.store(true, Ordering::SeqCst);
        }
        if kind == "agent_settled" {
            self.busy.store(false, Ordering::SeqCst);
        }
        let _ = events.send(record).await;
    }
    fn fail(&self, message: &str) {
        self.closed.store(true, Ordering::SeqCst);
        self.busy.store(false, Ordering::SeqCst);
        for (_, sender) in self.pending.lock().unwrap().drain() {
            let _ = sender.send(Err(message.to_owned()));
        }
    }
    pub fn notification_cursor(&self) -> u64 {
        self.notifications.lock().unwrap().0
    }
    pub fn notifications_after(&self, cursor: u64) -> Vec<Value> {
        self.notifications
            .lock()
            .unwrap()
            .1
            .iter()
            .filter(|(id, _)| *id > cursor)
            .map(|(_, value)| value.clone())
            .collect()
    }
    pub fn stderr(&self) -> String {
        String::from_utf8_lossy(&self.stderr.lock().unwrap()).into_owned()
    }
    pub async fn write(&self, record: Value) -> Result<()> {
        let mut shutdown = self.shutdown.subscribe();
        if self.closed.load(Ordering::SeqCst) || *shutdown.borrow() {
            bail!("Pi 未连接，请重新连接。");
        }
        let mut bytes = serde_json::to_vec(&record)?;
        bytes.push(b'\n');
        tokio::select! {
            _ = shutdown.changed() => bail!("Pi 正在关闭"),
            result = async {
                let mut guard = self.stdin.lock().await;
                let writer = guard.as_mut().context("Pi 输入管道已关闭")?;
                writer.write_all(&bytes).await.context("写入 Pi 管道失败")?;
                writer.flush().await?;
                Ok(())
            } => result,
        }
    }
    pub async fn request(
        self: &Arc<Self>,
        kind: &str,
        data: Value,
        duration: Duration,
    ) -> Result<Value> {
        if self.closed.load(Ordering::SeqCst) {
            bail!("Pi 未连接，请重新连接。");
        }
        let id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        let mut record = data.as_object().cloned().unwrap_or_default();
        record.insert("type".into(), kind.into());
        record.insert("id".into(), id.clone().into());
        self.pending.lock().unwrap().insert(id.clone(), sender);
        let _guard = PendingGuard {
            rpc: self.clone(),
            id,
        };
        timeout(duration, async {
            self.write(Value::Object(record)).await?;
            receiver
                .await
                .context("Pi 请求已取消")?
                .map_err(anyhow::Error::msg)
        })
        .await
        .with_context(|| format!("Pi 命令 {kind} 超时；请查看连接诊断。"))?
    }
    pub async fn call(self: &Arc<Self>, kind: &str, data: Value) -> Result<Value> {
        self.request(kind, data, Duration::from_secs(120)).await
    }
    pub async fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let _ = self.shutdown.send(true);
        let mut exited = self.exited.clone();
        let _ = timeout(Duration::from_secs(8), async {
            while !*exited.borrow() {
                if exited.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
        self.fail("Pi 已关闭");
    }
}
pub fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    #[cfg(not(windows))]
    let _ = command;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn jsonl_split_utf8_and_unicode_separators() {
        let expected = json!({"text":"你好🙂\u{2028}line\u{2029}end"});
        let bytes = format!("{}\r\n{{\"type\":\"done\"}}\n", expected).into_bytes();
        let mut parser = JsonLines::default();
        let mut records = Vec::new();
        for byte in bytes {
            records.extend(parser.push(&[byte]).unwrap());
        }
        assert_eq!(records, vec![expected, json!({"type":"done"})]);
        assert!(parser.finish().unwrap().is_empty());
    }
    #[test]
    fn malformed_record_is_reported() {
        assert!(JsonLines::default().push(b"oops\n").is_err());
    }
}
