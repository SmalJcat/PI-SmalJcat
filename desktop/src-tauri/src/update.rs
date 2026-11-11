//! 应用内更新（路线图 P0.3）：清单校验 → 版本比较 → 下载 → SHA-256 校验 → 暂存 → 重启应用。
//!
//! 设计约束：
//! - 不引入新的外部依赖，HTTP 下载复用系统 curl.exe，失败时回退 PowerShell。
//! - 核心逻辑（清单、版本、状态机、哈希、暂存、应用）与副作用解耦，可离线单元测试。
//! - 清单格式与仓库既有的 release/tauri/release.json 兼容（version/runtime/executable/bytes/sha256/stagedAt）。
//! - 暂存目录与目标路径都做越界校验；pending.json 只允许替换当前可执行文件。

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// 单个下载请求的超时时间（秒）。
pub const DOWNLOAD_TIMEOUT_SECS: u64 = 600;
/// 分块读取的大小，用于流式哈希。
const HASH_CHUNK: usize = 64 * 1024;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ---------------------------------------------------------------- 清单

/// 更新清单。字段与 release/tauri/release.json 对应，额外支持 url / notes。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateManifest {
    pub version: String,
    #[serde(default)]
    pub runtime: String,
    #[serde(default)]
    pub executable: String,
    #[serde(default)]
    pub bytes: u64,
    pub sha256: String,
    #[serde(default, rename = "stagedAt")]
    pub staged_at: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    /// 来源认证：由 scripts/release.mjs sign 写入。
    #[serde(default)]
    pub signature: Option<ManifestSignature>,
}

/// 清单签名块（字段名与 scripts/release.mjs 产出的 JSON 一致）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestSignature {
    #[serde(default)]
    pub algorithm: String,
    #[serde(default, rename = "keyId")]
    pub key_id: String,
    #[serde(default)]
    pub signature: String,
}

/// 规范载荷：必须与 src/release-manifest.mjs 的 canonicalPayload 逐字节一致。
/// 两端不一致时签名互不通过，由跨语言夹具测试守着（tests/fixtures/release-signed.json）。
pub fn release_payload(manifest: &UpdateManifest) -> String {
    format!(
        "pi-release-v1\nversion={}\nruntime={}\nexecutable={}\nbytes={}\nsha256={}\n",
        manifest.version,
        manifest.runtime,
        manifest.executable,
        manifest.bytes,
        manifest.sha256.to_lowercase()
    )
}

/// 读取信任库文本：keyId -> base64 公钥。损坏时返回空表，不阻塞启动。
pub fn parse_trusted_keys(text: &str) -> std::collections::BTreeMap<String, String> {
    let mut keys = std::collections::BTreeMap::new();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return keys;
    };
    let Some(list) = value.get("keys").and_then(|item| item.as_array()) else {
        return keys;
    };
    for entry in list {
        let (Some(id), Some(public)) = (
            entry.get("keyId").and_then(|item| item.as_str()),
            entry.get("publicKey").and_then(|item| item.as_str()),
        ) else {
            continue;
        };
        keys.insert(id.to_string(), public.to_string());
    }
    keys
}

/// 校验清单签名。未签名、算法不支持、密钥不在信任库、签名不匹配都会明确失败。
pub fn verify_manifest_signature(
    manifest: &UpdateManifest,
    trusted_keys: &std::collections::BTreeMap<String, String>,
) -> Result<()> {
    let Some(signature) = manifest.signature.as_ref() else {
        bail!("更新清单未签名");
    };
    if signature.algorithm != "ed25519" {
        bail!("不支持的签名算法：{}", signature.algorithm);
    }
    let key_base64 = trusted_keys
        .get(&signature.key_id)
        .with_context(|| format!("签名密钥不在信任库：{}", signature.key_id))?;
    let key_bytes = BASE64
        .decode(key_base64.trim())
        .context("信任库公钥不是合法 base64")?;
    let key_bytes: [u8; 32] = key_bytes
        .as_slice()
        .try_into()
        .context("信任库公钥不是 32 字节 Ed25519 公钥")?;
    let key = VerifyingKey::from_bytes(&key_bytes).context("信任库公钥不是合法 Ed25519 公钥")?;
    let signature_bytes = BASE64
        .decode(signature.signature.trim())
        .context("签名不是合法 base64")?;
    let parsed = Signature::from_slice(&signature_bytes).context("签名长度不是 64 字节")?;
    key.verify(&release_payload(manifest).into_bytes(), &parsed)
        .context("更新清单签名校验失败")?;
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// 解析并校验清单文本。任何不合法字段都以明确原因失败，不做猜测。
pub fn parse_manifest(text: &str) -> Result<UpdateManifest> {
    let manifest: UpdateManifest =
        serde_json::from_str(text).context("更新清单不是合法 JSON 或缺少必需字段")?;
    if manifest.version.trim().is_empty() {
        bail!("更新清单缺少版本号");
    }
    if parse_version(&manifest.version).is_none() {
        bail!("更新清单版本号格式无效：{}", manifest.version);
    }
    if !is_sha256(&manifest.sha256) {
        bail!("更新清单 sha256 必须是 64 位十六进制");
    }
    if manifest.bytes == 0 {
        bail!("更新清单 bytes 必须大于 0");
    }
    if !manifest.executable.trim().is_empty() && staged_file_name(&manifest.executable).is_none() {
        bail!("更新清单 executable 含非法路径：{}", manifest.executable);
    }
    Ok(manifest)
}

/// 只接受单一文件名，拒绝任何目录成分（防越界）。
pub fn staged_file_name(executable: &str) -> Option<String> {
    let path = Path::new(executable);
    if path.components().count() != 1 {
        return None;
    }
    match path.components().next() {
        Some(Component::Normal(name)) => name.to_str().map(|value| value.to_owned()),
        _ => None,
    }
}

// ---------------------------------------------------------------- 版本

/// 把语义化版本解析为可比较的数字序列，预发布段单独返回。
pub fn parse_version(value: &str) -> Option<(Vec<u64>, Vec<String>)> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let (core, pre) = match value.split_once('-') {
        Some((core, pre)) => (core, pre),
        None => (value, ""),
    };
    let core = core.split('+').next().unwrap_or(core);
    let mut numbers = Vec::new();
    for part in core.split('.') {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        numbers.push(part.parse::<u64>().ok()?);
    }
    while numbers.len() < 3 {
        numbers.push(0);
    }
    let pre = pre
        .split('.')
        .filter(|part| !part.is_empty())
        .map(|part| part.to_ascii_lowercase())
        .collect();
    Some((numbers, pre))
}

/// 比较两个版本。无法解析时回退为相等，避免把未知版本判成"有更新"。
pub fn compare_versions(left: &str, right: &str) -> Ordering {
    match (parse_version(left), parse_version(right)) {
        (Some((a, pre_a)), Some((b, pre_b))) => {
            a.cmp(&b)
                .then_with(|| match (pre_a.is_empty(), pre_b.is_empty()) {
                    // 预发布小于正式版；都有预发布段时按字典序比较。
                    (true, true) => Ordering::Equal,
                    (true, false) => Ordering::Greater,
                    (false, true) => Ordering::Less,
                    (false, false) => pre_a.cmp(&pre_b),
                })
        }
        _ => Ordering::Equal,
    }
}

// ---------------------------------------------------------------- 状态

/// 更新流程阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// 尚未检查，或未配置更新源。
    Idle,
    Checking,
    /// 发现可用版本，等待下载。
    Available,
    Downloading,
    Verifying,
    /// 已下载校验通过，等待应用（重启生效）。
    Ready,
    UpToDate,
    Failed,
}

/// 暴露给前端的更新状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub phase: Phase,
    pub current_version: String,
    pub available_version: Option<String>,
    pub progress_percent: u8,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub error: String,
    pub reason: String,
    pub source: Option<String>,
    pub notes: Option<String>,
    pub last_checked_at_ms: Option<u64>,
    pub staged_path: Option<String>,
}

impl UpdateState {
    fn new(current_version: &str) -> Self {
        Self {
            phase: Phase::Idle,
            current_version: current_version.to_owned(),
            available_version: None,
            progress_percent: 0,
            downloaded_bytes: 0,
            total_bytes: 0,
            error: String::new(),
            reason: String::new(),
            source: None,
            notes: None,
            last_checked_at_ms: None,
            staged_path: None,
        }
    }

    fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

// ---------------------------------------------------------------- 下载

/// 下载器抽象：真实实现调用系统 curl，测试用固定字节，保证核心逻辑可离线验证。
pub trait Downloader: Send + Sync {
    fn fetch(&self, url: &str, dest: &Path, progress: &mut dyn FnMut(u64)) -> Result<()>;
}

/// 通过系统 curl.exe 下载，失败时回退 PowerShell。
pub struct CommandDownloader {
    pub timeout_secs: u64,
}

impl CommandDownloader {
    pub fn new() -> Self {
        Self {
            timeout_secs: DOWNLOAD_TIMEOUT_SECS,
        }
    }
}

impl Default for CommandDownloader {
    fn default() -> Self {
        Self::new()
    }
}

/// 系统 curl.exe 路径（下载与 MCP HTTP 传输共用）。
pub fn curl_exe() -> PathBuf {
    PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()))
        .join("System32")
        .join("curl.exe")
}

impl CommandDownloader {
    fn spawn_curl(&self, url: &str, dest: &Path) -> Result<std::process::Child> {
        let child = Command::new(curl_exe())
            .args([
                "--location",
                "--fail",
                "--silent",
                "--show-error",
                "--output",
            ])
            .arg(dest)
            .args(["--max-time", &self.timeout_secs.to_string()])
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .context("无法启动系统 curl.exe（Windows 10 1803 之后自带）")?;
        Ok(child)
    }

    fn spawn_powershell(&self, url: &str, dest: &Path) -> Result<std::process::Child> {
        let script = format!(
            "$ErrorActionPreference='Stop';Invoke-WebRequest -UseBasicParsing -TimeoutSec {} -Uri '{}' -OutFile '{}'",
            self.timeout_secs,
            url.replace('\'', "''"),
            dest.to_string_lossy().replace('\'', "''")
        );
        let child = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &script,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .context("无法启动 powershell.exe 回退下载")?;
        Ok(child)
    }

    fn wait_with_progress(
        &self,
        child: &mut std::process::Child,
        dest: &Path,
        progress: &mut dyn FnMut(u64),
    ) -> Result<()> {
        let deadline = SystemTime::now() + Duration::from_secs(self.timeout_secs + 30);
        loop {
            if let Ok(meta) = fs::metadata(dest) {
                progress(meta.len());
            }
            if let Some(status) = child.try_wait()? {
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = pipe.read_to_string(&mut stderr);
                }
                if status.success() {
                    return Ok(());
                }
                bail!(
                    "下载失败：{}",
                    stderr.trim().chars().take(400).collect::<String>()
                );
            }
            if SystemTime::now() > deadline {
                let _ = child.kill();
                bail!("下载超时（{} 秒）", self.timeout_secs);
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

impl Downloader for CommandDownloader {
    fn fetch(&self, url: &str, dest: &Path, progress: &mut dyn FnMut(u64)) -> Result<()> {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).context("无法创建下载目录")?;
        }
        let mut child = match self.spawn_curl(url, dest) {
            Ok(child) => child,
            Err(_) => self.spawn_powershell(url, dest)?,
        };
        self.wait_with_progress(&mut child, dest, progress)
    }
}

// ---------------------------------------------------------------- 哈希

/// 流式计算 SHA-256，返回小写十六进制。
pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).with_context(|| format!("无法读取 {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_CHUNK];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

// ---------------------------------------------------------------- 暂存清单

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInstall {
    pub version: String,
    pub staged_path: String,
    pub sha256: String,
    pub target_path: String,
    pub staged_at_ms: u64,
}

/// 更新工作目录：<data_dir>/updates
pub fn updates_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("updates")
}

fn pending_path(data_dir: &Path) -> PathBuf {
    updates_dir(data_dir).join("pending.json")
}

/// 读取待应用更新；文件缺失或损坏时返回 None（不阻塞启动）。
pub fn read_pending(data_dir: &Path) -> Option<PendingInstall> {
    let text = fs::read_to_string(pending_path(data_dir)).ok()?;
    serde_json::from_str(&text).ok()
}

/// 路径是否位于 root 之内（拒绝 .. 与不同前缀）。
fn inside(root: &Path, candidate: &Path) -> bool {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let candidate = candidate
        .canonicalize()
        .unwrap_or_else(|_| candidate.to_path_buf());
    candidate.starts_with(root)
}

// ---------------------------------------------------------------- 管理器

/// 更新管理器：持有状态与配置，所有对外命令都经过它。
pub struct UpdateManager {
    data_dir: PathBuf,
    current_exe: PathBuf,
    current_version: String,
    source: Mutex<Option<String>>,
    state: Mutex<UpdateState>,
    manifest: Mutex<Option<UpdateManifest>>,
    downloader: Box<dyn Downloader>,
}

impl UpdateManager {
    pub fn new(data_dir: PathBuf, current_exe: PathBuf, current_version: &str) -> Self {
        Self {
            data_dir,
            current_exe,
            current_version: current_version.to_owned(),
            source: Mutex::new(std::env::var("PI_DESKTOP_UPDATE_URL").ok()),
            state: Mutex::new(UpdateState::new(current_version)),
            manifest: Mutex::new(None),
            downloader: Box::new(CommandDownloader::new()),
        }
    }

    /// 注入下载器，仅用于测试。
    pub fn with_downloader(mut self, downloader: Box<dyn Downloader>) -> Self {
        self.downloader = downloader;
        self
    }

    /// 进入失败态并返回状态快照。必须先释放状态锁，否则会与 status() 互相等待。
    fn fail(&self, error: String, reason: &str) -> Value {
        {
            let mut state = self.state.lock().unwrap();
            state.phase = Phase::Failed;
            state.error = error;
            state.reason = reason.to_owned();
        }
        self.status()
    }

    pub fn set_source(&self, source: Option<String>) {
        *self.source.lock().unwrap() = source.filter(|value| !value.trim().is_empty());
        let mut state = self.state.lock().unwrap();
        state.source = self.source.lock().unwrap().clone();
    }

    pub fn status(&self) -> Value {
        let state = self.state.lock().unwrap();
        let mut value = state.to_value();
        if let Some(object) = value.as_object_mut() {
            object.insert("sourceConfigured".into(), json!(state.source.is_some()));
            object.insert(
                "canCheck".into(),
                json!(!matches!(
                    state.phase,
                    Phase::Checking | Phase::Downloading | Phase::Verifying
                )),
            );
            object.insert("canDownload".into(), json!(state.phase == Phase::Available));
            object.insert("canInstall".into(), json!(state.phase == Phase::Ready));
        }
        value
    }

    /// 读取发布信任库（<data_dir>/release-trusted-keys.json）。
    /// 缺失或损坏都返回空表——空表表示未启用来源认证，而不是"校验通过"。
    fn release_trusted_keys(&self) -> std::collections::BTreeMap<String, String> {
        fs::read_to_string(self.data_dir.join("release-trusted-keys.json"))
            .map(|text| parse_trusted_keys(&text))
            .unwrap_or_default()
    }

    /// 用清单文本检查更新（离线/夹具路径，不发起网络请求）。
    pub fn check_text(&self, text: &str) -> Result<Value> {
        let manifest = parse_manifest(text)?;
        // 来源认证：信任库非空时强制要求有效签名（未签名 / 密钥不在库 / 被篡改都拒绝）。
        let trusted = self.release_trusted_keys();
        if !trusted.is_empty() {
            verify_manifest_signature(&manifest, &trusted).context("更新清单未通过来源认证")?;
        }
        let now = now_ms();
        {
            let mut state = self.state.lock().unwrap();
            state.last_checked_at_ms = Some(now);
            state.error.clear();
            state.reason.clear();
            state.progress_percent = 0;
            state.downloaded_bytes = 0;
            state.total_bytes = manifest.bytes;
            state.notes = manifest.notes.clone();
            match compare_versions(&manifest.version, &self.current_version) {
                Ordering::Greater => {
                    state.phase = Phase::Available;
                    state.available_version = Some(manifest.version.clone());
                    state.reason = format!(
                        "发现新版本 {}（当前 {}）",
                        manifest.version, self.current_version
                    );
                }
                _ => {
                    state.phase = Phase::UpToDate;
                    state.available_version = None;
                    state.reason = format!("已是最新版本（{}）", self.current_version);
                }
            }
        }
        *self.manifest.lock().unwrap() = Some(manifest);
        Ok(self.status())
    }

    /// 从更新源检查（先取清单文本，再走同一套校验）。
    pub fn check_remote(&self) -> Result<Value> {
        let source = self.source.lock().unwrap().clone();
        let Some(url) = source else {
            {
                let mut state = self.state.lock().unwrap();
                state.phase = Phase::Idle;
                state.reason = "未配置更新源（设置 PI_DESKTOP_UPDATE_URL）".into();
            }
            return Ok(self.status());
        };
        {
            let mut state = self.state.lock().unwrap();
            state.phase = Phase::Checking;
            state.reason = "正在检查更新".into();
        }
        let manifest_text = self.fetch_manifest_text(&url)?;
        self.check_text(&manifest_text)
    }

    fn fetch_manifest_text(&self, url: &str) -> Result<String> {
        let target = updates_dir(&self.data_dir).join("manifest.json.part");
        let mut sink = |_bytes: u64| {};
        self.downloader
            .fetch(url, &target, &mut sink)
            .with_context(|| format!("无法获取更新清单 {url}"))?;
        let text = fs::read_to_string(&target).context("更新清单不是 UTF-8 文本")?;
        let _ = fs::remove_file(&target);
        Ok(text)
    }

    /// 下载可用版本并校验哈希，成功后进入 Ready。
    pub fn download(&self) -> Result<Value> {
        let manifest = self
            .manifest
            .lock()
            .unwrap()
            .clone()
            .context("请先检查更新")?;
        if self.state.lock().unwrap().phase != Phase::Available {
            bail!("当前状态不可下载");
        }
        let url = manifest
            .url
            .clone()
            .or_else(|| self.source.lock().unwrap().clone())
            .context("更新清单未提供下载地址")?;
        let file_name = staged_file_name(&manifest.executable)
            .unwrap_or_else(|| format!("pi-desktop-{}.exe", manifest.version));
        let dir = updates_dir(&self.data_dir).join(&manifest.version);
        fs::create_dir_all(&dir).context("无法创建暂存目录")?;
        if !inside(&self.data_dir, &dir) {
            bail!("暂存目录越界");
        }
        let staged = dir.join(&file_name);
        let partial = dir.join(format!("{file_name}.part"));

        {
            let mut state = self.state.lock().unwrap();
            state.phase = Phase::Downloading;
            state.progress_percent = 0;
            state.downloaded_bytes = 0;
            state.total_bytes = manifest.bytes;
            state.reason = format!("正在下载 {}", manifest.version);
        }
        let total = manifest.bytes.max(1);
        let state = &self.state;
        let mut progress = |bytes: u64| {
            if let Ok(mut state) = state.lock() {
                state.downloaded_bytes = bytes;
                state.progress_percent = ((bytes.saturating_mul(100) / total).min(99)) as u8;
            }
        };
        let result = self.downloader.fetch(&url, &partial, &mut progress);
        if let Err(error) = result {
            let _ = fs::remove_file(&partial);
            return Ok(self.fail(format!("{error:#}"), "下载失败"));
        }

        {
            let mut state = self.state.lock().unwrap();
            state.phase = Phase::Verifying;
            state.reason = "正在校验下载内容".into();
        }
        let observed = match sha256_file(&partial) {
            Ok(value) => value,
            Err(error) => {
                let _ = fs::remove_file(&partial);
                return Ok(self.fail(format!("{error:#}"), "无法读取下载内容"));
            }
        };
        if !observed.eq_ignore_ascii_case(&manifest.sha256) {
            let _ = fs::remove_file(&partial);
            return Ok(self.fail(
                format!("期望 {}，实际 {}", manifest.sha256, observed),
                "校验失败，已丢弃下载内容",
            ));
        }
        fs::rename(&partial, &staged).context("无法保存下载内容")?;
        {
            let mut state = self.state.lock().unwrap();
            state.phase = Phase::Ready;
            state.progress_percent = 100;
            state.downloaded_bytes = manifest.bytes;
            state.staged_path = Some(staged.to_string_lossy().into_owned());
            state.reason = format!(
                "{} 已就绪，关闭并重新打开 Pi Desktop 后生效",
                manifest.version
            );
        }
        Ok(self.status())
    }

    /// 写入待应用更新。真正的文件替换发生在下次启动（启动时应用）。
    pub fn install(&self) -> Result<Value> {
        let state = self.state.lock().unwrap().clone();
        if state.phase != Phase::Ready {
            bail!("没有已校验的更新可应用");
        }
        let manifest = self
            .manifest
            .lock()
            .unwrap()
            .clone()
            .context("缺少更新清单")?;
        let staged = state.staged_path.clone().context("缺少已暂存的更新文件")?;
        if !inside(&self.data_dir, Path::new(&staged)) {
            bail!("暂存文件越界，拒绝应用");
        }
        let pending = PendingInstall {
            version: manifest.version.clone(),
            staged_path: staged.clone(),
            sha256: manifest.sha256.clone(),
            target_path: self.current_exe.to_string_lossy().into_owned(),
            staged_at_ms: now_ms(),
        };
        let path = pending_path(&self.data_dir);
        fs::create_dir_all(path.parent().context("缺少更新目录")?)?;
        fs::write(
            &path,
            serde_json::to_vec_pretty(&pending).context("无法序列化待应用更新")?,
        )
        .context("无法写入待应用更新")?;
        {
            let mut state = self.state.lock().unwrap();
            state.reason = format!(
                "{} 将在下次启动时替换当前程序；如失败会保留回滚副本",
                manifest.version
            );
            state.phase = Phase::Ready;
        }
        Ok(self.status())
    }
}

// ---------------------------------------------------------------- 启动应用

/// 启动时应用待更新。任何失败都返回 Err 但**不阻塞启动**，由调用方记录。
pub fn apply_pending_with(data_dir: &Path, current_exe: &Path) -> Result<Option<String>> {
    let Some(pending) = read_pending(data_dir) else {
        return Ok(None);
    };
    let target = PathBuf::from(&pending.target_path);
    if target != current_exe {
        // 只允许替换当前正在运行的程序，避免 pending.json 被利用去覆盖任意文件。
        return Err(anyhow::anyhow!(
            "待应用更新的目标与当前程序不一致，已忽略：{}",
            target.display()
        ));
    }
    let staged = PathBuf::from(&pending.staged_path);
    if !inside(data_dir, &staged) {
        bail!("暂存文件越界，已忽略");
    }
    if !staged.is_file() {
        bail!("暂存文件已不存在：{}", staged.display());
    }
    let observed = sha256_file(&staged)?;
    if !observed.eq_ignore_ascii_case(&pending.sha256) {
        bail!("暂存文件校验失败，已忽略");
    }
    let backup = target.with_extension(format!("bak-{}", pending.version));
    if target.exists() {
        // Windows 允许重命名正在运行的 exe，随后把新文件放到原路径。
        let _ = fs::remove_file(&backup);
        fs::rename(&target, &backup)
            .with_context(|| format!("无法备份当前程序到 {}", backup.display()))?;
    }
    fs::copy(&staged, &target).with_context(|| format!("无法写入新程序到 {}", target.display()))?;
    let _ = fs::remove_file(pending_path(data_dir));
    let _ = fs::remove_file(&staged);
    Ok(Some(format!(
        "已应用 {}（回滚副本 {}）",
        pending.version,
        backup.display()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct FixtureDownloader {
        body: Vec<u8>,
        fail: bool,
    }

    impl Downloader for FixtureDownloader {
        fn fetch(&self, _url: &str, dest: &Path, progress: &mut dyn FnMut(u64)) -> Result<()> {
            if self.fail {
                bail!("夹具下载失败");
            }
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut file = fs::File::create(dest)?;
            file.write_all(&self.body)?;
            progress(self.body.len() as u64);
            Ok(())
        }
    }

    fn manifest_text(version: &str, body: &[u8]) -> String {
        let digest = {
            let mut hasher = Sha256::new();
            hasher.update(body);
            format!("{:x}", hasher.finalize())
        };
        serde_json::json!({
            "version": version,
            "runtime": "tauri",
            "executable": "Pi Desktop.exe",
            "bytes": body.len(),
            "sha256": digest,
            "stagedAt": "2026-11-07T00:00:00.000Z",
            "url": "https://example.invalid/pi-desktop.zip"
        })
        .to_string()
    }

    fn manager(dir: &Path, body: &[u8]) -> UpdateManager {
        UpdateManager::new(dir.to_path_buf(), dir.join("Pi Desktop.exe"), "0.4.1").with_downloader(
            Box::new(FixtureDownloader {
                body: body.to_vec(),
                fail: false,
            }),
        )
    }

    #[test]
    fn cross_language_signed_manifest_verifies() {
        // 夹具由 tests/release.test.mjs 用固定种子确定性生成，两端载荷必须逐字节一致
        let manifest = parse_manifest(include_str!("../tests/fixtures/release-signed.json"))
            .expect("Node 生成的清单应当可以解析");
        assert_eq!(manifest.version, "9.9.9");
        assert_eq!(manifest.bytes, 4242);
        let keys = parse_trusted_keys(include_str!("../tests/fixtures/release-trusted-keys.json"));
        assert_eq!(keys.len(), 1, "夹具信任库应有一个密钥");

        verify_manifest_signature(&manifest, &keys).expect("跨语言签名应当通过校验");

        // 身份字段被改动必须失败
        let mut tampered = manifest.clone();
        tampered.bytes += 1;
        assert!(verify_manifest_signature(&tampered, &keys).is_err());
        let mut renamed = manifest.clone();
        renamed.executable = "Other.exe".into();
        assert!(verify_manifest_signature(&renamed, &keys).is_err());

        // 未知密钥与未签名都要失败
        assert!(verify_manifest_signature(&manifest, &Default::default()).is_err());
        let unsigned = parse_manifest(
            r#"{"version":"1.0.0","runtime":"tauri","executable":"a.exe","bytes":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
        )
        .unwrap();
        assert!(verify_manifest_signature(&unsigned, &keys).is_err());

        // 展示字段不参与载荷，改动不应破坏签名
        let mut annotated = manifest.clone();
        annotated.notes = Some("补充说明".into());
        annotated.staged_at = Some("2026-02-02T00:00:00.000Z".into());
        verify_manifest_signature(&annotated, &keys).expect("展示字段不应破坏签名");
    }

    #[test]
    fn trusted_keys_parsing_tolerates_damage() {
        assert!(parse_trusted_keys("这不是 json").is_empty());
        assert!(parse_trusted_keys("{}").is_empty());
        let keys = parse_trusted_keys(
            r#"{"keys":[{"keyId":"a","publicKey":"AAA"},{"publicKey":"BBB"},{"keyId":"c"}]}"#,
        );
        assert_eq!(keys.len(), 1, "缺字段的条目应当被跳过");
        assert_eq!(keys.get("a").map(String::as_str), Some("AAA"));
    }

    #[test]
    fn manifest_validation_rejects_bad_input() {
        let body = b"payload".to_vec();
        let good = parse_manifest(&manifest_text("0.4.2", &body)).unwrap();
        assert_eq!(good.bytes, 7);
        assert!(parse_manifest("{}").is_err());
        assert!(parse_manifest(r#"{"version":"0.4.2","sha256":"short","bytes":10}"#).is_err());
        assert!(parse_manifest(
            r#"{"version":"0.4.2","sha256":"0000000000000000000000000000000000000000000000000000000000000000","bytes":0}"#
        )
        .is_err());
        assert!(parse_manifest(
            r#"{"version":"not-a-version","sha256":"0000000000000000000000000000000000000000000000000000000000000000","bytes":1}"#
        )
        .is_err());
        assert!(parse_manifest(
            r#"{"version":"0.4.2","sha256":"0000000000000000000000000000000000000000000000000000000000000000","bytes":1,"executable":"..\\evil.exe"}"#
        )
        .is_err());
    }

    #[test]
    fn staged_file_name_only_accepts_plain_names() {
        assert_eq!(
            staged_file_name("Pi Desktop.exe").as_deref(),
            Some("Pi Desktop.exe")
        );
        assert_eq!(staged_file_name("..\\evil.exe"), None);
        assert_eq!(staged_file_name("a/b.exe"), None);
        assert_eq!(staged_file_name(""), None);
    }

    #[test]
    fn version_comparison_handles_padding_and_prerelease() {
        assert_eq!(compare_versions("0.4.2", "0.4.1"), Ordering::Greater);
        assert_eq!(compare_versions("0.4.1", "0.4.1"), Ordering::Equal);
        assert_eq!(compare_versions("0.5", "0.5.0"), Ordering::Equal);
        assert_eq!(compare_versions("0.9.9", "0.10.0"), Ordering::Less);
        assert_eq!(compare_versions("1.0.0-rc.1", "1.0.0"), Ordering::Less);
        assert_eq!(compare_versions("1.0.0", "1.0.0-beta"), Ordering::Greater);
        assert_eq!(compare_versions("", "1.0.0"), Ordering::Equal);
        assert!(parse_version("1.2.3+build7").is_some());
    }

    #[test]
    fn check_reports_up_to_date_for_same_version() {
        let dir = tempfile::tempdir().unwrap();
        let body = b"payload".to_vec();
        let manager = manager(dir.path(), &body);
        let state = manager.check_text(&manifest_text("0.4.2", &body)).unwrap();
        assert_eq!(state["phase"], "available");
        assert_eq!(state["availableVersion"], "0.4.2");
        assert_eq!(state["canDownload"], true);
        let state = manager.check_text(&manifest_text("0.4.1", &body)).unwrap();
        assert_eq!(state["phase"], "up_to_date");
        assert_eq!(state["canDownload"], false);
        let state = manager.check_text(&manifest_text("0.3.9", &body)).unwrap();
        assert_eq!(state["phase"], "up_to_date");
    }

    #[test]
    fn download_verifies_hash_and_stages() {
        let dir = tempfile::tempdir().unwrap();
        let body = b"new-binary-bytes".to_vec();
        let manager = manager(dir.path(), &body);
        manager.check_text(&manifest_text("0.4.2", &body)).unwrap();
        let state = manager.download().unwrap();
        assert_eq!(state["phase"], "ready");
        assert_eq!(state["progressPercent"], 100);
        let staged = PathBuf::from(state["stagedPath"].as_str().unwrap());
        assert!(staged.is_file());
        assert_eq!(fs::read(&staged).unwrap(), body);
        assert!(inside(dir.path(), &staged));
        // 重复下载在 ready 状态下被拒绝。
        assert!(manager.download().is_err());
    }

    #[test]
    fn download_discards_bytes_when_hash_mismatches() {
        let dir = tempfile::tempdir().unwrap();
        let declared = b"declared-bytes".to_vec();
        let manager = UpdateManager::new(
            dir.path().to_path_buf(),
            dir.path().join("Pi Desktop.exe"),
            "0.4.1",
        )
        .with_downloader(Box::new(FixtureDownloader {
            body: b"tampered-bytes".to_vec(),
            fail: false,
        }));
        manager
            .check_text(&manifest_text("0.4.2", &declared))
            .unwrap();
        let state = manager.download().unwrap();
        assert_eq!(state["phase"], "failed");
        assert!(state["reason"].as_str().unwrap().contains("校验失败"));
        let staged_dir = updates_dir(dir.path()).join("0.4.2");
        if staged_dir.exists() {
            assert_eq!(fs::read_dir(&staged_dir).unwrap().count(), 0);
        }
    }

    #[test]
    fn download_failure_is_reported_not_panicked() {
        let dir = tempfile::tempdir().unwrap();
        let body = b"payload".to_vec();
        let manager = UpdateManager::new(
            dir.path().to_path_buf(),
            dir.path().join("Pi Desktop.exe"),
            "0.4.1",
        )
        .with_downloader(Box::new(FixtureDownloader {
            body: body.clone(),
            fail: true,
        }));
        manager.check_text(&manifest_text("0.4.2", &body)).unwrap();
        let state = manager.download().unwrap();
        assert_eq!(state["phase"], "failed");
        assert!(state["error"].as_str().unwrap().contains("夹具下载失败"));
    }

    #[test]
    fn install_writes_pending_and_apply_swaps_files() {
        let dir = tempfile::tempdir().unwrap();
        let body = b"brand-new".to_vec();
        let exe = dir.path().join("Pi Desktop.exe");
        fs::write(&exe, b"old").unwrap();
        let manager = UpdateManager::new(dir.path().to_path_buf(), exe.clone(), "0.4.1")
            .with_downloader(Box::new(FixtureDownloader {
                body: body.clone(),
                fail: false,
            }));
        assert!(manager.install().is_err(), "未下载前不应允许应用");
        manager.check_text(&manifest_text("0.4.2", &body)).unwrap();
        manager.download().unwrap();
        let state = manager.install().unwrap();
        assert_eq!(state["phase"], "ready");
        assert!(pending_path(dir.path()).is_file());

        let applied = apply_pending_with(dir.path(), &exe).unwrap().unwrap();
        assert!(applied.contains("0.4.2"));
        assert_eq!(fs::read(&exe).unwrap(), body);
        assert!(fs::read(dir.path().join("Pi Desktop.bak-0.4.2")).is_ok());
        assert!(!pending_path(dir.path()).exists());
        // 再次启动没有待应用更新。
        assert!(apply_pending_with(dir.path(), &exe).unwrap().is_none());
    }

    #[test]
    fn apply_pending_refuses_a_foreign_target() {
        let dir = tempfile::tempdir().unwrap();
        let other = dir.path().join("other");
        fs::create_dir_all(&other).unwrap();
        let victim = other.join("victim.exe");
        fs::write(&victim, b"keep-me").unwrap();
        let staged = updates_dir(dir.path()).join("evil.exe");
        fs::create_dir_all(staged.parent().unwrap()).unwrap();
        fs::write(&staged, b"payload").unwrap();
        let pending = PendingInstall {
            version: "9.9.9".into(),
            staged_path: staged.to_string_lossy().into_owned(),
            sha256: sha256_file(&staged).unwrap(),
            target_path: victim.to_string_lossy().into_owned(),
            staged_at_ms: 1,
        };
        fs::write(
            pending_path(dir.path()),
            serde_json::to_vec(&pending).unwrap(),
        )
        .unwrap();
        let error = apply_pending_with(dir.path(), &dir.path().join("Pi Desktop.exe")).unwrap_err();
        assert!(error.to_string().contains("目标与当前程序不一致"));
        assert_eq!(fs::read(&victim).unwrap(), b"keep-me");
    }

    #[test]
    fn apply_pending_ignores_a_corrupt_marker() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(updates_dir(dir.path())).unwrap();
        fs::write(pending_path(dir.path()), b"not json").unwrap();
        assert!(apply_pending_with(dir.path(), &dir.path().join("x.exe"))
            .unwrap()
            .is_none());
    }
}
