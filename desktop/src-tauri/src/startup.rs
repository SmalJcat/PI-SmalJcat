//! 开机自启（Windows）：通过当前用户的 Run 注册表项登记本程序。
//!
//! 不引入额外插件：只用 reg.exe 读写一个键值，行为透明且可测。
//! 关键设计：注册表路径作为参数传入，测试使用独立的测试键，绝不触碰用户真实的开机启动项。

use anyhow::{bail, Context, Result};
use std::path::Path;
use std::process::Command;

/// 真实的开机启动键（当前用户）。
pub const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
/// 测试专用键：只在本模块的测试里使用。
pub const TEST_KEY: &str = r"HKCU\Software\PiDesktop\TestRun";
/// 注册表值名。
pub const VALUE_NAME: &str = "Pi Desktop";

fn run(args: &[&str]) -> Result<std::process::Output> {
    Command::new("reg.exe")
        .args(args)
        .output()
        .context("无法执行 reg.exe")
}

/// 生成登记项的命令行：路径加引号，避免空格被拆开。
pub fn command_for(executable: &Path) -> String {
    format!("\"{}\"", executable.display())
}

/// 查询是否已登记。
pub fn is_enabled(key: &str) -> Result<bool> {
    let output = run(&["query", key, "/v", VALUE_NAME])?;
    Ok(output.status.success())
}

/// 写入登记项。
pub fn set_enabled(key: &str, command: &str) -> Result<()> {
    if command.trim().is_empty() {
        bail!("启动命令不能为空");
    }
    let output = run(&[
        "add", key, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", command, "/f",
    ])?;
    if !output.status.success() {
        bail!(
            "写入开机启动项失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

/// 取消登记（键值不存在也算成功）。
pub fn remove(key: &str) -> Result<()> {
    let output = run(&["delete", key, "/v", VALUE_NAME, "/f"])?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("无法找到") || stderr.to_lowercase().contains("unable to find") {
        return Ok(());
    }
    bail!("删除开机启动项失败：{}", stderr.trim());
}

/// 读取已登记的命令（不存在时为 None）。
pub fn registered_command(key: &str) -> Result<Option<String>> {
    let output = run(&["query", key, "/v", VALUE_NAME])?;
    if !output.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    for line in text.lines() {
        if let Some(index) = line.find("REG_SZ") {
            let value = line[index + "REG_SZ".len()..].trim();
            if !value.is_empty() {
                return Ok(Some(value.to_string()));
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn command_is_quoted_for_paths_with_spaces() {
        let command = command_for(&PathBuf::from(r"C:\Program Files\Pi\pi-desktop.exe"));
        assert_eq!(command, r#""C:\Program Files\Pi\pi-desktop.exe""#);
        assert!(command.starts_with('"') && command.ends_with('"'));
    }

    #[test]
    fn empty_command_is_rejected() {
        assert!(set_enabled(TEST_KEY, "   ").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn set_query_and_remove_round_trip_on_a_test_key() {
        // 只操作测试键，真实开机启动项不受影响
        let _ = remove(TEST_KEY);
        assert!(!is_enabled(TEST_KEY).unwrap(), "测试键初始应当不存在");

        let command = command_for(&PathBuf::from(r"C:\Temp\pi desktop.exe"));
        set_enabled(TEST_KEY, &command).unwrap();
        assert!(is_enabled(TEST_KEY).unwrap(), "写入后应当查询得到");
        assert_eq!(
            registered_command(TEST_KEY).unwrap().as_deref(),
            Some(command.as_str())
        );

        remove(TEST_KEY).unwrap();
        assert!(!is_enabled(TEST_KEY).unwrap(), "删除后应当查询不到");
        // 重复删除不报错
        remove(TEST_KEY).unwrap();
    }
}
