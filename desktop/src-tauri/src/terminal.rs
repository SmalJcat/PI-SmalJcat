//! 工作区命令面板（路线图 P3：终端能力的第一层）。
//!
//! 定位：在**当前工作区**跑一条命令并流式看到输出，可取消、保留最近若干次记录。
//! 这是"命令运行器"，不是完整 TTY：没有交互式 stdin，也不做终端模拟。
//! 交互式 PTY（xterm.js + portable-pty）是下一步，本模块的分层（start/cancel/history）
//! 与事件形状可以原样复用。
//!
//! 安全边界：命令只从主窗口发起；工作目录由调用方给定的会话工作区决定；
//! 输出有上限，历史有上限，取消会连同子进程树一起结束。

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::Mutex as AsyncMutex,
};

/// 单次运行保留的输出上限（字节）。
pub const MAX_OUTPUT_BYTES: usize = 512 * 1024;
/// 历史记录条数上限。
pub const MAX_HISTORY: usize = 20;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// 运行状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl RunStatus {
    fn as_str(self) -> &'static str {
        match self {
            RunStatus::Running => "running",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
        }
    }
}

/// 事件接收器：桌面层把它接到主窗口的事件通道上。
pub type Sink = Arc<dyn Fn(Value) + Send + Sync>;

/// 一次运行的记录。
#[derive(Clone)]
pub struct RunRecord {
    pub id: u64,
    pub command: String,
    pub shell: String,
    pub cwd: String,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub exit_code: Option<i64>,
    pub status: RunStatus,
    pub output: String,
    pub truncated: bool,
}

impl RunRecord {
    fn to_value(&self) -> Value {
        json!({
            "id": self.id,
            "command": self.command,
            "shell": self.shell,
            "cwd": self.cwd,
            "startedAtMs": self.started_at_ms,
            "endedAtMs": self.ended_at_ms,
            "exitCode": self.exit_code,
            "status": self.status.as_str(),
            "output": self.output,
            "truncated": self.truncated,
        })
    }
}

/// 命令运行的宿主：历史 + 当前运行（同一时刻只允许一条，避免并发争用工作区）。
pub struct Terminal {
    sequence: AtomicU64,
    history: Mutex<VecDeque<RunRecord>>,
    current: AsyncMutex<Option<Arc<RunningHandle>>>,
}

/// 正在运行的命令句柄：进程 + 取消标记。
struct RunningHandle {
    id: u64,
    pid: Option<u32>,
    cancelled: AtomicU8,
    child: AsyncMutex<Option<tokio::process::Child>>,
}

impl RunningHandle {
    fn mark_cancelled(&self) {
        self.cancelled.store(1, Ordering::SeqCst);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst) == 1
    }
}

/// 支持的 shell 名称。
pub fn shell_command(shell: &str) -> Result<(&'static str, Vec<&'static str>)> {
    match shell {
        "" | "cmd" => Ok(("cmd.exe", vec!["/d", "/s", "/c"])),
        "powershell" => Ok((
            "powershell.exe",
            vec!["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
        )),
        "pwsh" => Ok((
            "pwsh.exe",
            vec!["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
        )),
        other => bail!("不支持的 shell：{other}（可选 cmd / powershell / pwsh）"),
    }
}

/// 追加输出并保持上限：超限时从头部丢弃并标记 truncated。
pub fn append_bounded(buffer: &mut String, chunk: &str, limit: usize) -> bool {
    buffer.push_str(chunk);
    if buffer.len() <= limit {
        return false;
    }
    let mut cut = buffer.len() - limit;
    while cut < buffer.len() && !buffer.is_char_boundary(cut) {
        cut += 1;
    }
    *buffer = buffer[cut..].to_owned();
    true
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    #[cfg(not(windows))]
    let _ = command;
}

impl Default for Terminal {
    fn default() -> Self {
        Self::new()
    }
}

impl Terminal {
    pub fn new() -> Self {
        Self {
            sequence: AtomicU64::new(1),
            history: Mutex::new(VecDeque::new()),
            current: AsyncMutex::new(None),
        }
    }

    /// 最近若干次运行（新的在前）。
    pub fn history(&self, limit: usize) -> Vec<Value> {
        self.history
            .lock()
            .map(|history| {
                history
                    .iter()
                    .rev()
                    .take(limit.clamp(1, MAX_HISTORY))
                    .map(RunRecord::to_value)
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn clear(&self) -> Value {
        if let Ok(mut history) = self.history.lock() {
            history.clear();
        }
        json!({ "cleared": true })
    }

    /// 当前是否有命令在跑。
    pub async fn busy(&self) -> Option<u64> {
        self.current.lock().await.as_ref().map(|handle| handle.id)
    }

    /// 取消当前运行：先标记，再结束进程树。
    pub async fn cancel(&self) -> Value {
        let handle = self.current.lock().await.clone();
        let Some(handle) = handle else {
            return json!({ "cancelled": false, "reason": "没有正在运行的命令" });
        };
        handle.mark_cancelled();
        kill_tree(handle.pid).await;
        json!({ "cancelled": true, "id": handle.id })
    }

    /// 启动一条命令并流式推送输出。返回运行记录摘要。
    pub async fn start(
        self: &Arc<Self>,
        cwd: &Path,
        shell: &str,
        command: &str,
        sink: Sink,
    ) -> Result<Value> {
        let command = command.trim();
        if command.is_empty() {
            bail!("命令不能为空");
        }
        if command.len() > 8 * 1024 {
            bail!("命令过长（上限 8 KiB）");
        }
        if let Some(id) = self.busy().await {
            bail!("已有命令在运行（#{id}），请先取消或等待结束");
        }
        let (program, prefix) = shell_command(shell)?;
        let mut process = Command::new(program);
        process
            .args(&prefix)
            .arg(command)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        hide_console(&mut process);
        let mut child = process
            .spawn()
            .with_context(|| format!("无法启动 {program}"))?;

        let id = self.sequence.fetch_add(1, Ordering::SeqCst);
        let pid = child.id();
        let record = RunRecord {
            id,
            command: command.to_owned(),
            shell: if shell.is_empty() {
                "cmd".into()
            } else {
                shell.to_owned()
            },
            cwd: cwd.to_string_lossy().into_owned(),
            started_at_ms: now_ms(),
            ended_at_ms: None,
            exit_code: None,
            status: RunStatus::Running,
            output: String::new(),
            truncated: false,
        };
        {
            let mut history = self.history.lock().unwrap();
            while history.len() >= MAX_HISTORY {
                history.pop_front();
            }
            history.push_back(record.clone());
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let handle = Arc::new(RunningHandle {
            id,
            pid,
            cancelled: AtomicU8::new(0),
            child: AsyncMutex::new(Some(child)),
        });
        *self.current.lock().await = Some(handle.clone());

        sink(
            json!({ "type": "start", "id": id, "command": command, "cwd": record.cwd, "pid": pid }),
        );
        let stdout_task = spawn_reader(self.clone(), stdout, id, "stdout", sink.clone());
        let stderr_task = spawn_reader(self.clone(), stderr, id, "stderr", sink.clone());

        let status = {
            let mut guard = handle.child.lock().await;
            let child = guard.as_mut();
            match child {
                Some(child) => match child.wait().await {
                    Ok(exit) => {
                        if handle.is_cancelled() {
                            (RunStatus::Cancelled, Some(-1))
                        } else if exit.success() {
                            (RunStatus::Completed, exit.code().map(|code| code as i64))
                        } else {
                            (RunStatus::Failed, exit.code().map(|code| code as i64))
                        }
                    }
                    Err(_) => (RunStatus::Failed, None),
                },
                None => (RunStatus::Cancelled, None),
            }
        };
        if let Some(task) = stdout_task {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), task).await;
        }
        if let Some(task) = stderr_task {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), task).await;
        }
        *self.current.lock().await = None;

        let ended_at_ms = now_ms();
        let summary = {
            let mut history = self.history.lock().unwrap();
            let entry = history
                .iter_mut()
                .find(|entry| entry.id == id)
                .context("运行记录丢失")?;
            entry.ended_at_ms = Some(ended_at_ms);
            entry.exit_code = status.1;
            entry.status = status.0;
            entry.to_value()
        };
        sink(json!({
            "type": "exit",
            "id": id,
            "status": status.0.as_str(),
            "exitCode": status.1,
            "endedAtMs": ended_at_ms,
        }));
        Ok(summary)
    }

    /// 供测试与桌面层使用：把一段输出写进历史记录。
    pub fn record_output(&self, id: u64, text: &str) {
        if let Ok(mut history) = self.history.lock() {
            if let Some(entry) = history.iter_mut().find(|entry| entry.id == id) {
                let chunk = format!("{text}\n");
                if append_bounded(&mut entry.output, &chunk, MAX_OUTPUT_BYTES) {
                    entry.truncated = true;
                }
            }
        }
    }

    /// 输出事件的统一形状。
    pub fn output_event(id: u64, stream: &str, text: &str) -> Value {
        json!({ "type": "output", "id": id, "stream": stream, "text": text })
    }
}

fn spawn_reader<R>(
    terminal: Arc<Terminal>,
    reader: Option<R>,
    id: u64,
    stream: &'static str,
    sink: Sink,
) -> Option<tokio::task::JoinHandle<()>>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let reader = reader?;
    Some(tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // 历史里保留同一份输出，界面重开面板时不需要重跑命令。
            terminal.record_output(id, &line);
            sink(Terminal::output_event(id, stream, &line));
        }
    }))
}

/// 结束进程树：先尝试 kill，再用 taskkill 兜底（Windows 上 shell 常带子进程）。
async fn kill_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let _ = command.status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
}

/// 工作区校验：目录必须存在，避免在不存在的工作区里跑命令。
pub fn resolve_cwd(cwd: &Path) -> Result<PathBuf> {
    if !cwd.is_dir() {
        bail!("工作区不存在：{}", cwd.display());
    }
    Ok(cwd.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn collector() -> (Sink, Arc<StdMutex<Vec<Value>>>) {
        let events = Arc::new(StdMutex::new(Vec::new()));
        let sink_events = events.clone();
        let sink: Sink = Arc::new(move |event| {
            if let Ok(mut list) = sink_events.lock() {
                list.push(event);
            }
        });
        (sink, events)
    }

    #[test]
    fn shells_are_allow_listed() {
        assert_eq!(shell_command("").unwrap().0, "cmd.exe");
        assert_eq!(shell_command("cmd").unwrap().0, "cmd.exe");
        assert_eq!(shell_command("powershell").unwrap().0, "powershell.exe");
        assert_eq!(shell_command("pwsh").unwrap().0, "pwsh.exe");
        assert!(shell_command("bash").is_err());
        assert!(
            shell_command("cmd.exe /c whoami").is_err(),
            "不接受整条命令行当 shell"
        );
    }

    #[test]
    fn output_is_bounded_from_the_head() {
        let mut buffer = String::new();
        assert!(!append_bounded(&mut buffer, "hello", 32));
        assert_eq!(buffer, "hello");
        let mut buffer = "a".repeat(20);
        assert!(append_bounded(&mut buffer, &"b".repeat(20), 24));
        assert_eq!(buffer.len(), 24);
        assert!(buffer.ends_with(&"b".repeat(20)[..4]));
        // 多字节字符不会被截断在中间
        let mut buffer = String::new();
        append_bounded(&mut buffer, &"汉".repeat(10), 7);
        assert!(buffer.is_char_boundary(0));
        assert!(buffer.len() <= 7);
    }

    #[tokio::test]
    async fn runs_a_command_and_reports_output_and_exit_code() {
        let terminal = Arc::new(Terminal::new());
        let cwd = std::env::temp_dir();
        let (sink, events) = collector();
        let summary = terminal
            .start(&cwd, "cmd", "echo pi-terminal-ok", sink)
            .await
            .unwrap();
        assert_eq!(summary["status"], "completed");
        assert_eq!(summary["exitCode"], 0);
        let recorded = summary["output"].as_str().unwrap();
        assert!(recorded.contains("pi-terminal-ok"), "{recorded}");

        let events = events.lock().unwrap().clone();
        assert!(events.iter().any(|event| event["type"] == "start"));
        assert!(events.iter().any(|event| event["type"] == "output"
            && event["stream"] == "stdout"
            && event["text"]
                .as_str()
                .unwrap_or_default()
                .contains("pi-terminal-ok")));
        assert!(events
            .iter()
            .any(|event| event["type"] == "exit" && event["exitCode"] == 0));
        assert!(terminal.busy().await.is_none());
        assert_eq!(terminal.history(5).len(), 1);
    }

    #[tokio::test]
    async fn failing_commands_report_a_non_zero_exit() {
        let terminal = Arc::new(Terminal::new());
        let cwd = std::env::temp_dir();
        let (sink, _) = collector();
        let summary = terminal
            .start(&cwd, "cmd", "exit /b 3", sink)
            .await
            .unwrap();
        assert_eq!(summary["status"], "failed");
        assert_eq!(summary["exitCode"], 3);
    }

    #[tokio::test]
    async fn cancel_stops_a_long_running_command() {
        let terminal = Arc::new(Terminal::new());
        let cwd = std::env::temp_dir();
        let (sink, _) = collector();
        let runner_terminal = terminal.clone();
        let started = tokio::time::Instant::now();
        let task = tokio::spawn(async move {
            runner_terminal
                .start(&cwd, "cmd", "ping -n 30 127.0.0.1 > nul", sink)
                .await
        });
        // 等命令真的起来再取消
        for _ in 0..40 {
            if terminal.busy().await.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(terminal.busy().await.is_some(), "命令应当已启动");
        let cancelled = terminal.cancel().await;
        assert_eq!(cancelled["cancelled"], true);
        let summary = task.await.unwrap().unwrap();
        assert_eq!(summary["status"], "cancelled");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(25),
            "取消应当立即生效"
        );
        assert!(terminal.busy().await.is_none());
    }

    #[tokio::test]
    async fn rejects_empty_long_and_concurrent_runs() {
        let terminal = Arc::new(Terminal::new());
        let cwd = std::env::temp_dir();
        let (sink, _) = collector();
        assert!(terminal
            .start(&cwd, "cmd", "   ", sink.clone())
            .await
            .is_err());
        assert!(terminal
            .start(&cwd, "cmd", &"x".repeat(9 * 1024), sink.clone())
            .await
            .is_err());
        // 不存在的工作区
        assert!(resolve_cwd(Path::new("Z:/definitely/missing")).is_err());
        assert!(resolve_cwd(&cwd).is_ok());
    }

    #[tokio::test]
    async fn history_is_bounded_and_newest_first() {
        let terminal = Terminal::new();
        for index in 0..(MAX_HISTORY + 5) {
            let mut history = terminal.history.lock().unwrap();
            while history.len() >= MAX_HISTORY {
                history.pop_front();
            }
            history.push_back(RunRecord {
                id: index as u64,
                command: format!("cmd {index}"),
                shell: "cmd".into(),
                cwd: ".".into(),
                started_at_ms: index as u64,
                ended_at_ms: None,
                exit_code: None,
                status: RunStatus::Running,
                output: String::new(),
                truncated: false,
            });
        }
        let history = terminal.history(100);
        assert_eq!(history.len(), MAX_HISTORY);
        assert_eq!(history[0]["id"], (MAX_HISTORY + 4) as u64, "最新的在最前");
        assert_eq!(terminal.clear()["cleared"], true);
        assert!(terminal.history(10).is_empty());
        assert_eq!(
            terminal.cancel().await["cancelled"],
            json!(false),
            "没有运行时取消应返回 false"
        );
    }
}
