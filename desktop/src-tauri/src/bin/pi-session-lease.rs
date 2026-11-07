//! Test-only second owner for deterministic session-conflict UI checks.
use anyhow::{ensure, Context, Result};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
};

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    ensure!(args.len() == 2, "expected lock directory and session path");
    let lease =
        pi_desktop::session_guard::acquire(&PathBuf::from(&args[0]), &PathBuf::from(&args[1]))
            .context("test session lease unavailable")?;
    println!("session-lease-ready");
    io::stdout().flush()?;
    // EOF also releases the lock when the test runner dies.
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line)?;
    drop(lease);
    Ok(())
}
