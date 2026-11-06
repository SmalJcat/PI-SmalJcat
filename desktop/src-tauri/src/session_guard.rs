//! Desktop leases are cooperative: Pi CLI does not honor them. Unknown live Pi
//! processes therefore make an in-place resume unsafe and require a fork.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::SystemTime,
};

pub struct Lease {
    _file: File,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stamp {
    size: u64,
    modified: SystemTime,
    tail: Vec<u8>,
}
pub fn stamp(file: &Path) -> Result<Option<Stamp>> {
    let mut file = match File::open(file) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let metadata = file.metadata()?;
    file.seek(SeekFrom::Start(metadata.len().saturating_sub(4096)))?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail)?;
    Ok(Some(Stamp {
        size: metadata.len(),
        modified: metadata.modified()?,
        tail,
    }))
}
pub fn key(path: &Path) -> Result<String> {
    let path = if path.exists() {
        crate::workspace::canonical(path)?
    } else {
        let parent = path.parent().context("会话路径没有父目录")?;
        fs::create_dir_all(parent)?;
        crate::workspace::canonical(parent)?.join(path.file_name().context("无效会话路径")?)
    };
    let text = path.to_string_lossy().replace('\\', "/");
    Ok(if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    })
}
pub fn acquire(root: &Path, session: &Path) -> Result<Lease> {
    fs::create_dir_all(root)?;
    let digest = format!("{:x}", Sha256::digest(key(session)?.as_bytes()));
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join(format!("{digest}.lock")))?;
    file.try_lock()
        .context("会话已被另一个 Pi Desktop 占用，请复制为新会话")?;
    Ok(Lease { _file: file })
}
pub fn check(
    root: &Path,
    session: &Path,
    own_path: Option<&Path>,
    own_pid: Option<u32>,
) -> Result<Value> {
    let own = own_path.is_some_and(|path| key(path).ok() == key(session).ok());
    if own {
        return Ok(json!({"available":true,"reason":"当前会话","canFork":true}));
    }
    let _lease = match acquire(root, session) {
        Ok(lease) => lease,
        Err(error) => {
            return Ok(json!({"available":false,"reason":error.to_string(),"canFork":true}))
        }
    };
    let other = pi_processes()?
        .into_iter()
        .filter(|pid| Some(*pid) != own_pid)
        .collect::<Vec<_>>();
    if !other.is_empty() {
        return Ok(
            json!({"available":false,"reason":"检测到其他 Pi 进程，无法确认它是否正在使用此会话。请复制为新会话继续，原文件不会被修改。","canFork":true,"processIds":other}),
        );
    }
    Ok(json!({"available":true,"reason":"未检测到占用","canFork":true}))
}
pub fn pi_processes() -> Result<HashSet<u32>> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
            System::Diagnostics::ToolHelp::*,
        };
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                bail!("无法检查 Pi 进程占用，请通过副本继续");
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut more = Process32FirstW(snapshot, &mut entry);
            let mut pids = HashSet::new();
            while more != 0 {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|v| *v == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..end]).to_lowercase();
                if name == "pi.exe" {
                    pids.insert(entry.th32ProcessID);
                }
                more = Process32NextW(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            Ok(pids)
        }
    }
    #[cfg(not(windows))]
    {
        Ok(HashSet::new())
    }
}
pub struct SessionGuard {
    pub path: PathBuf,
    pub lease: Lease,
    pub baseline: Option<Stamp>,
    pub known_processes: HashSet<u32>,
    pub expecting_write: bool,
}
impl SessionGuard {
    pub fn validate(&self, pid: u32) -> Result<()> {
        self.validate_with_managed(pid, &HashSet::new())
    }
    pub fn validate_with_managed(&self, pid: u32, managed: &HashSet<u32>) -> Result<()> {
        if !self.expecting_write && stamp(&self.path)? != self.baseline {
            bail!("SESSION_CHANGED: 会话文件已被外部程序修改。请重新载入，或复制为新会话；本次操作未发送。");
        }
        let current = pi_processes()?;
        if current
            .iter()
            .any(|p| *p != pid && !self.known_processes.contains(p) && !managed.contains(p))
        {
            bail!("SESSION_CHANGED: 检测到新的 Pi 进程。请停止其他客户端或复制会话后继续。");
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exclusive_lock_released_with_owner() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        fs::write(&path, "a").unwrap();
        let owner = acquire(&dir.path().join("locks"), &path).unwrap();
        assert!(acquire(&dir.path().join("locks"), &path).is_err());
        drop(owner);
        assert!(acquire(&dir.path().join("locks"), &path).is_ok());
    }
    #[test]
    fn same_length_external_write_detected() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("session");
        fs::write(&file, "abc").unwrap();
        let before = stamp(&file).unwrap();
        fs::write(&file, "def").unwrap();
        assert_ne!(stamp(&file).unwrap(), before);
    }
}
