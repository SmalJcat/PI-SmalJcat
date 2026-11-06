use crate::{
    context::{atomic_json, clipped, now},
    rpc::{EventSink, Rpc},
    session_guard, workspace,
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::{watch, Mutex as AsyncMutex, Semaphore};
use uuid::Uuid;

const OUTPUT_LIMIT: usize = 128 * 1024;
pub const CONCURRENCY: usize = 4;
const READ_TOOLS: &str = "read,grep,find,ls";
const DEFAULT_PROMPT: &str = "你是主代理的只读探子，负责探索、检索和独立核验。仅使用只读工具，不修改文件，不执行实现任务，不派生子代理。只依据当前任务提供的目标、范围和约束开展工作，不假定了解主代理对话。区分事实、推断和未知，简洁返回结论，并附准确的文件路径、行号和必要原文。";

#[derive(Clone)]
pub struct Runner {
    pub executable: PathBuf,
    pub prefix: Vec<String>,
}
pub struct NewTask {
    pub task: String,
    pub cwd: PathBuf,
    pub parent_session: String,
    pub model: String,
    pub thinking: String,
    pub system_prompt: String,
    pub owner: String,
    pub project_trusted: bool,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Task {
    pub id: String,
    pub agent: String,
    pub task: String,
    pub cwd: PathBuf,
    pub parent_session: String,
    pub model: String,
    pub thinking: String,
    pub status: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub session_path: Option<PathBuf>,
    pub retry_of: Option<String>,
    pub attempts: u64,
    pub output: String,
    pub partial: String,
    pub truncated: bool,
    pub tools: Vec<Value>,
    pub usage: Value,
    pub error: Option<String>,
    pub system_prompt: String,
    pub owner: String,
    pub project_trusted: bool,
    #[serde(skip)]
    last_saved: u64,
}
impl Task {
    fn active(&self) -> bool {
        matches!(
            self.status.as_str(),
            "queued" | "starting" | "running" | "cancelling"
        )
    }
    fn public(&self, detail: bool) -> Value {
        let mut value = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Some(object) = value.as_object_mut() {
            object.remove("systemPrompt");
            if !detail {
                object.remove("tools");
                object.remove("partial");
                object.insert("output".into(), clipped(&self.output, 240).into());
            }
            object.insert(
                "canResume".into(),
                json!(
                    !self.active()
                        && self.status != "completed"
                        && self.session_path.as_ref().is_some_and(|p| p.is_file())
                ),
            );
            object.insert(
                "canOpenParent".into(),
                json!(!self.parent_session.is_empty() && Path::new(&self.parent_session).is_file()),
            );
        }
        value
    }
}
struct Job {
    cancel: AtomicU8,
    signal: watch::Sender<bool>,
    rpc: Mutex<Option<Arc<Rpc>>>,
    lease: Mutex<Option<session_guard::Lease>>,
}
#[derive(Clone)]
enum Completion {
    Pending,
    Settled,
    Failed(String),
}

pub struct Manager {
    root: PathBuf,
    lease_root: PathBuf,
    admin: Mutex<()>,
    records: Mutex<HashMap<String, Task>>,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    semaphore: Arc<Semaphore>,
    closing: AtomicBool,
    pub launch_lock: AsyncMutex<()>,
    pids: Mutex<HashSet<u32>>,
    warnings: Mutex<Vec<String>>,
}
impl Manager {
    pub fn new(root: PathBuf, lease_root: PathBuf) -> Result<Arc<Self>> {
        fs::create_dir_all(&root)?;
        let mut records = HashMap::new();
        let mut warnings = Vec::new();
        let mut files = fs::read_dir(&root)?
            .flatten()
            .filter(|entry| {
                entry.file_type().is_ok_and(|t| t.is_file())
                    && entry.path().extension().is_some_and(|ext| ext == "json")
            })
            .collect::<Vec<_>>();
        files.sort_by_key(|entry| {
            std::cmp::Reverse(entry.metadata().ok().and_then(|m| m.modified().ok()))
        });
        for entry in files.into_iter().take(300) {
            let file = entry.path();
            let read = (|| -> Result<Task> {
                if fs::metadata(&file)?.len() > 1024 * 1024 {
                    bail!("记录过大");
                }
                let task: Task = serde_json::from_slice(&fs::read(&file)?)?;
                if Uuid::parse_str(&task.id).is_err()
                    || file.file_stem().and_then(|s| s.to_str()) != Some(&task.id)
                {
                    bail!("记录 ID 无效");
                }
                Ok(task)
            })();
            match read {
                Ok(mut task) => {
                    if task.active() {
                        task.status = "interrupted".into();
                        task.finished_at = Some(now());
                        task.updated_at = now();
                        task.error =
                            Some("应用退出时任务尚未结束，可继续已保存的会话或重新运行。".into());
                        atomic_json(&file, &serde_json::to_value(&task)?)?;
                    }
                    records.insert(task.id.clone(), task);
                }
                Err(_) => warnings.push(format!(
                    "无法读取任务记录 {}，原文件已保留。",
                    file.file_name().unwrap_or_default().to_string_lossy()
                )),
            }
        }
        Ok(Arc::new(Self {
            root,
            lease_root,
            admin: Mutex::new(()),
            records: Mutex::new(records),
            jobs: Mutex::new(HashMap::new()),
            semaphore: Arc::new(Semaphore::new(CONCURRENCY)),
            closing: AtomicBool::new(false),
            launch_lock: AsyncMutex::new(()),
            pids: Mutex::new(HashSet::new()),
            warnings: Mutex::new(warnings),
        }))
    }
    pub fn pids(&self) -> HashSet<u32> {
        self.pids.lock().unwrap().clone()
    }
    pub fn busy(&self) -> bool {
        !self.jobs.lock().unwrap().is_empty()
    }
    fn update(&self, id: &str, force: bool, update: impl FnOnce(&mut Task)) {
        let mut records = self.records.lock().unwrap();
        if let Some(task) = records.get_mut(id) {
            update(task);
            task.updated_at = now();
            if force || now().saturating_sub(task.last_saved) > 500 {
                task.last_saved = now();
                if let Err(error) = atomic_json(
                    &self.root.join(format!("{id}.json")),
                    &serde_json::to_value(&*task).unwrap_or(Value::Null),
                ) {
                    let message = format!("任务记录保存失败：{error}");
                    let mut warnings = self.warnings.lock().unwrap();
                    if warnings.last() != Some(&message) {
                        warnings.push(message);
                        warnings.truncate(20);
                    }
                }
            }
        }
    }
    fn task(&self, id: &str) -> Result<Task> {
        self.records
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .context("找不到该任务")
    }
    pub fn list(&self) -> Value {
        let records = self.records.lock().unwrap();
        let mut rows = records.values().collect::<Vec<_>>();
        rows.sort_by_key(|task| std::cmp::Reverse(task.created_at));
        json!({"tasks":rows.into_iter().take(300).map(|t|t.public(false)).collect::<Vec<_>>(),"concurrency":CONCURRENCY,"active":self.jobs.lock().unwrap().len(),"warnings":*self.warnings.lock().unwrap()})
    }
    pub fn detail(&self, id: &str) -> Result<Value> {
        Ok(self.task(id)?.public(true))
    }
    pub fn start(
        self: &Arc<Self>,
        spec: NewTask,
        runner: Runner,
        retry_of: Option<String>,
    ) -> Result<Value> {
        let _admin = self.admin.lock().unwrap();
        let NewTask {
            task,
            cwd,
            parent_session,
            model,
            thinking,
            system_prompt,
            owner,
            project_trusted,
        } = spec;
        if task.trim().is_empty() || task.len() > 32 * 1024 {
            bail!("任务不能为空，且最多 32 KB");
        }
        validate_model(&model)?;
        if !["off", "minimal", "low", "medium", "high", "xhigh", "max"].contains(&thinking.as_str())
        {
            bail!("思考强度无效");
        }
        let cwd = workspace::canonical(&cwd)?;
        if !cwd.is_dir() {
            bail!("工作区不存在");
        }
        let id = Uuid::new_v4().to_string();
        let time = now();
        let record = Task {
            id: id.clone(),
            agent: "default".into(),
            task,
            cwd,
            parent_session,
            model,
            thinking,
            status: "queued".into(),
            created_at: time,
            updated_at: time,
            retry_of,
            attempts: 1,
            system_prompt,
            owner,
            project_trusted,
            ..Task::default()
        };
        atomic_json(
            &self.root.join(format!("{id}.json")),
            &serde_json::to_value(&record)?,
        )?;
        self.records.lock().unwrap().insert(id.clone(), record);
        if let Err(error) = self.enqueue(id.clone(), runner, false) {
            self.update(&id, true, |task| {
                task.status = "failed".into();
                task.error = Some(error.to_string());
            });
            return Err(error);
        }
        self.detail(&id)
    }
    pub fn retry(self: &Arc<Self>, id: &str, runner: Runner, resume: bool) -> Result<Value> {
        let old = self.task(id)?;
        if old.active() {
            bail!("请先停止当前任务");
        }
        if resume {
            let _admin = self.admin.lock().unwrap();
            if self.task(id)?.active() {
                bail!("任务已在运行");
            }
            let path = old
                .session_path
                .as_ref()
                .filter(|p| p.is_file())
                .context("没有可继续的已保存子会话，请重新运行")?;
            workspace::within_workspace(&self.root, &path.to_string_lossy())?;
            self.update(id, true, |task| {
                task.status = "queued".into();
                task.error = None;
                task.finished_at = None;
                task.partial.clear();
                task.owner.clear();
                task.attempts += 1;
            });
            if let Err(error) = self.enqueue(id.into(), runner, true) {
                self.update(id, true, |task| {
                    task.status = "interrupted".into();
                    task.error = Some(error.to_string());
                });
                return Err(error);
            }
            self.detail(id)
        } else {
            self.start(
                NewTask {
                    task: old.task,
                    cwd: old.cwd,
                    parent_session: old.parent_session,
                    model: old.model,
                    thinking: old.thinking,
                    system_prompt: old.system_prompt,
                    owner: String::new(),
                    project_trusted: old.project_trusted,
                },
                runner,
                Some(id.into()),
            )
        }
    }
    fn enqueue(self: &Arc<Self>, id: String, runner: Runner, resume: bool) -> Result<()> {
        let (signal, _) = watch::channel(false);
        let job = Arc::new(Job {
            cancel: AtomicU8::new(0),
            signal,
            rpc: Mutex::new(None),
            lease: Mutex::new(None),
        });
        {
            let mut jobs = self.jobs.lock().unwrap();
            if self.closing.load(Ordering::SeqCst) {
                bail!("应用正在关闭");
            }
            if jobs.len() >= 32 {
                bail!("最多同时保留 32 个运行或排队任务");
            }
            if jobs.contains_key(&id) {
                bail!("任务已在运行");
            }
            jobs.insert(id.clone(), job.clone());
        }
        let manager = self.clone();
        tokio::spawn(async move {
            manager.run(id, job, runner, resume).await;
        });
        Ok(())
    }
    pub fn cancel(&self, id: &str, interrupted: bool) -> Result<Value> {
        let _admin = self.admin.lock().unwrap();
        let job = self
            .jobs
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .context("任务已结束")?;
        job.cancel
            .store(if interrupted { 2 } else { 1 }, Ordering::SeqCst);
        job.signal.send_replace(true);
        self.update(id, true, |task| task.status = "cancelling".into());
        self.detail(id)
    }
    pub fn cancel_owner(&self, owner: &str, interrupted: bool) {
        let ids = self
            .records
            .lock()
            .unwrap()
            .values()
            .filter(|task| task.active() && !task.owner.is_empty() && task.owner == owner)
            .map(|task| task.id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            let _ = self.cancel(&id, interrupted);
        }
    }
    async fn run(self: Arc<Self>, id: String, job: Arc<Job>, runner: Runner, resume: bool) {
        let mut cancelled = job.signal.subscribe();
        let permit = if job.cancel.load(Ordering::SeqCst) > 0 {
            None
        } else {
            tokio::select! {permit=self.semaphore.clone().acquire_owned()=>permit.ok(),_=cancelled.changed()=>None}
        };
        let result = if permit.is_some() && job.cancel.load(Ordering::SeqCst) == 0 {
            self.update(&id, true, |task| {
                task.status = "starting".into();
                task.started_at = Some(now());
            });
            tokio::select! {
                result=tokio::time::timeout(Duration::from_secs(3600),self.run_rpc(&id,&job,&runner,resume))=>result.context("子代理任务超过一小时，请重试或继续会话").and_then(|r|r),
                _=cancelled.changed()=>Ok(()),
            }
        } else {
            Ok(())
        };
        let rpc = job.rpc.lock().unwrap().clone();
        if let Some(rpc) = rpc {
            if mode_is_cancelled(&job) {
                if let Ok(stats) = rpc
                    .request("get_session_stats", json!({}), Duration::from_secs(2))
                    .await
                {
                    self.update(&id, true, |task| task.usage = stats);
                }
            }
            rpc.stop().await;
            self.pids.lock().unwrap().remove(&rpc.pid);
        }
        job.lease.lock().unwrap().take();
        let mode = job.cancel.load(Ordering::SeqCst);
        self.update(&id, true, |task| {
            task.finished_at = Some(now());
            if !task.partial.is_empty() {
                append_text(&mut task.output, &task.partial, &mut task.truncated);
                task.partial.clear();
            }
            task.status = if mode == 2 {
                "interrupted"
            } else if mode == 1 {
                "cancelled"
            } else if result.is_err() || task.error.is_some() {
                "failed"
            } else {
                "completed"
            }
            .into();
            if let Err(error) = result {
                task.error = Some(clipped(&format!("{error:#}"), 4000));
            }
            if mode == 2 {
                task.error = Some("应用关闭时任务被中断，可继续已保存的会话。".into());
            }
        });
        drop(permit);
        self.jobs.lock().unwrap().remove(&id);
    }
    async fn run_rpc(
        self: &Arc<Self>,
        id: &str,
        job: &Arc<Job>,
        runner: &Runner,
        resume: bool,
    ) -> Result<()> {
        let record = self.task(id)?;
        let directory = self.root.join(id);
        fs::create_dir_all(&directory)?;
        let prompt = directory.join("system.txt");
        fs::write(
            &prompt,
            format!("{DEFAULT_PROMPT}\n\n{}", record.system_prompt),
        )?;
        let mut args = vec![
            "--offline".into(),
            "--no-extensions".into(),
            "--no-mcp".into(),
            "--no-skills".into(),
            "--no-prompt-templates".into(),
            "--no-context-files".into(),
            "--tools".into(),
            READ_TOOLS.into(),
            "--exclude-tools".into(),
            "mcp__*".into(),
            "--model".into(),
            record.model.clone(),
            "--thinking".into(),
            record.thinking.clone(),
            "--append-system-prompt".into(),
            prompt.to_string_lossy().into_owned(),
            "--session-dir".into(),
            directory.to_string_lossy().into_owned(),
        ];
        if resume {
            args.extend([
                "--session".into(),
                record
                    .session_path
                    .as_ref()
                    .context("会话路径缺失")?
                    .to_string_lossy()
                    .into_owned(),
            ]);
        }
        if record.project_trusted {
            args.push("--approve".into());
        }
        let (completion, mut done) = watch::channel(Completion::Pending);
        let weak = Arc::downgrade(self);
        let task_id = id.to_owned();
        let sink: EventSink = Arc::new(move |event| {
            if let Some(manager) = weak.upgrade() {
                manager.event(&task_id, &event);
            }
            if event["type"] == "agent_settled" {
                completion.send_replace(Completion::Settled);
            }
            if event["type"] == "transport_exit" {
                completion.send_replace(Completion::Failed(
                    event["message"].as_str().unwrap_or("子代理进程退出").into(),
                ));
            }
        });
        let rpc = {
            let _launch = self.launch_lock.lock().await;
            if job.cancel.load(Ordering::SeqCst) > 0 {
                return Ok(());
            }
            let rpc = Rpc::spawn(
                &runner.executable,
                &record.cwd,
                &runner.prefix,
                &args,
                sink,
                &[("PI_DESKTOP_TASK_ID".into(), id.into())],
            )
            .await?;
            self.pids.lock().unwrap().insert(rpc.pid);
            *job.rpc.lock().unwrap() = Some(rpc.clone());
            rpc
        };
        let state = rpc.call("get_state", json!({})).await?;
        let session = PathBuf::from(
            state["sessionFile"]
                .as_str()
                .context("Pi 未返回持久化子会话路径")?,
        );
        let parent = workspace::canonical(session.parent().context("子会话路径无效")?)?;
        if !parent.starts_with(workspace::canonical(&directory)?) {
            bail!("Pi 子会话没有写入任务专用目录");
        }
        *job.lease.lock().unwrap() = Some(session_guard::acquire(&self.lease_root, &session)?);
        self.update(id, true, |task| {
            task.session_path = Some(session);
            task.status = "running".into();
        });
        let message = if resume {
            format!("继续之前的只读探索任务，检查已完成部分后补齐剩余工作；不要重复已完成的无关检索。原任务：\n{}",record.task)
        } else {
            format!("只读探索任务：\n{}", record.task)
        };
        rpc.request(
            "prompt",
            json!({"message":message}),
            Duration::from_secs(3600),
        )
        .await?;
        loop {
            let state = done.borrow().clone();
            match state {
                Completion::Settled => break,
                Completion::Failed(error) => bail!("{error}"),
                Completion::Pending => {}
            }
            done.changed().await.context("子代理状态通道已关闭")?;
        }
        if let Ok(stats) = rpc.call("get_session_stats", json!({})).await {
            self.update(id, true, |task| task.usage = stats);
        }
        Ok(())
    }
    fn event(&self, id: &str, event: &Value) {
        self.update(id,event["type"]=="message_end",|task|{
            if !task.active(){return;}
            match event["type"].as_str().unwrap_or_default(){
                "message_start" if event["message"]["role"]=="assistant"=>task.partial.clear(),
                "message_update" if event["assistantMessageEvent"]["type"]=="text_delta"=>{
                    let delta=event["assistantMessageEvent"]["delta"].as_str().unwrap_or_default();append_text(&mut task.partial,delta,&mut task.truncated);
                }
                "message_end" if event["message"]["role"]=="assistant"=>{
                    let message=&event["message"]; let text=message_text(&message["content"]);
                    if !text.is_empty(){if !task.output.is_empty(){append_text(&mut task.output,"\n\n",&mut task.truncated);}append_text(&mut task.output,&text,&mut task.truncated);}
                    task.partial.clear();
                    if message["usage"].is_object(){
                        if !task.usage.is_object(){task.usage=json!({"tokens":{},"cost":0.0});}
                        for key in ["input","output","cacheRead","cacheWrite","totalTokens"] {
                            if let Some(value)=message["usage"][key].as_u64(){let field=if key=="totalTokens"{"total"}else{key};task.usage["tokens"][field]=(task.usage["tokens"][field].as_u64().unwrap_or_default()+value).into();}
                        }
                        task.usage["cost"]=(task.usage["cost"].as_f64().unwrap_or_default()+message["usage"]["cost"]["total"].as_f64().unwrap_or_default()).into();
                    }
                    if let Some(error)=message["errorMessage"].as_str().filter(|s|!s.is_empty()){task.error=Some(clipped(error,4000));}
                    if message["stopReason"]=="error"&&task.error.is_none(){task.error=Some("模型返回错误".into());}
                }
                "tool_execution_start"=>{
                    if task.tools.len()>=40{task.tools.remove(0);}
                    task.tools.push(json!({"id":event["toolCallId"],"name":event["toolName"],"args":clipped(&event["args"].to_string(),2000),"status":"running"}));
                }
                "tool_execution_end"=>{
                    if let Some(tool)=task.tools.iter_mut().find(|tool|tool["id"]==event["toolCallId"]){tool["status"]=if event["isError"]==true{"failed"}else{"completed"}.into();tool["output"]=clipped(&message_text(&event["result"]["content"]),8000).into();}
                }
                _=>{}
            }
        });
    }
    pub async fn shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        let ids = self
            .jobs
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            let _ = self.cancel(&id, true);
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while self.busy() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}
fn append_text(output: &mut String, text: &str, truncated: &mut bool) {
    let remaining = OUTPUT_LIMIT.saturating_sub(output.len());
    if text.len() > remaining {
        *truncated = true;
    }
    output.push_str(&clipped(text, remaining));
}
fn mode_is_cancelled(job: &Job) -> bool {
    job.cancel.load(Ordering::SeqCst) > 0
}
fn message_text(content: &Value) -> String {
    content.as_str().map(String::from).unwrap_or_else(|| {
        content
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b["type"] == "text")
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    })
}
fn validate_model(model: &str) -> Result<()> {
    if model.is_empty()
        || model.len() > 250
        || model.starts_with('-')
        || model.chars().any(char::is_whitespace)
    {
        bail!("请选择有效模型");
    }
    Ok(())
}

/// The workbench intentionally exposes only the user's default read-only scout.
pub fn definition(agent_dir: &Path) -> Result<Value> {
    let file = agent_dir.join("agents/default.md");
    if !file.exists() {
        return Ok(
            json!({"name":"default","description":"只读探索与独立核验","model":"","thinking":"medium","systemPrompt":DEFAULT_PROMPT,"tools":READ_TOOLS,"source":"内置"}),
        );
    }
    if fs::metadata(&file)?.len() > 64 * 1024 {
        bail!("default 代理定义超过 64 KB");
    }
    let text = fs::read_to_string(&file)?;
    let mut model = String::new();
    let mut description = String::from("只读探索与独立核验");
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        bail!("default 代理定义缺少 YAML 头");
    }
    let mut body = false;
    let mut prompt = Vec::new();
    for line in lines {
        if body {
            prompt.push(line);
            continue;
        }
        if line.trim() == "---" {
            body = true;
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let value = value.trim();
            let value = if value.starts_with('"') {
                serde_json::from_str::<String>(value).context("代理定义中的引号无效")?
            } else if value.starts_with('\'') && value.ends_with('\'') {
                value[1..value.len() - 1].replace("''", "'")
            } else {
                value.to_owned()
            };
            match key.trim() {
                "model" => model = value,
                "description" => description = value,
                _ => {}
            }
        }
    }
    if !body {
        bail!("default 代理定义头部未结束");
    }
    let levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    let mut thinking = "medium".to_owned();
    if let Some((base, suffix)) = model.rsplit_once(':') {
        if levels.contains(&suffix) {
            thinking = suffix.to_owned();
            model = base.to_owned();
        }
    }
    if !model.is_empty() {
        validate_model(&model)?;
    }
    Ok(
        json!({"name":"default","description":description,"model":model,"thinking":thinking,"systemPrompt":prompt.join("\n"),"tools":READ_TOOLS,"source":file}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_task_is_loaded_without_automatic_execution() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        let task = Task {
            id: id.clone(),
            status: "running".into(),
            output: "已完成的部分".into(),
            ..Task::default()
        };
        atomic_json(
            &dir.path().join(format!("{id}.json")),
            &serde_json::to_value(task).unwrap(),
        )
        .unwrap();
        let manager = Manager::new(dir.path().to_path_buf(), dir.path().join("locks")).unwrap();
        assert!(!manager.busy());
        let recovered = manager.detail(&id).unwrap();
        assert_eq!(recovered["status"], "interrupted");
        assert_eq!(recovered["output"], "已完成的部分");
    }
    #[test]
    fn default_definition_retains_prompt_and_parses_thinking_suffix() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("agents")).unwrap();
        fs::write(dir.path().join("agents/default.md"),"---\nname: default\ndescription: scout\nmodel: 'p/model:high'\ntools: read, bash\n---\n只读检索").unwrap();
        let agent = definition(dir.path()).unwrap();
        assert_eq!(agent["model"], "p/model");
        assert_eq!(agent["thinking"], "high");
        assert_eq!(agent["tools"], READ_TOOLS);
        assert_eq!(agent["systemPrompt"], "只读检索");
    }
}
