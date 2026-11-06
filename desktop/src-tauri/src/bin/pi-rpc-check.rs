use anyhow::{bail, Result};
use pi_desktop::rpc::{EventSink, Rpc};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

#[tokio::main]
async fn main() -> Result<()> {
    let executable = std::env::var_os("PI_DESKTOP_EXECUTABLE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../pi.exe"));
    let cwd = executable.parent().unwrap().to_path_buf();
    let model_test = std::env::args().any(|a| a == "--model");
    let mut args: Vec<String> = ["--no-session", "--offline"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if model_test {
        args.extend(
            [
                "--no-tools",
                "--no-extensions",
                "--no-skills",
                "--no-context-files",
                "--no-prompt-templates",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
    }
    let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let deltas = Arc::new(AtomicUsize::new(0));
    let delta_counter = deltas.clone();
    let sink: EventSink = Arc::new(move |event| {
        if event["type"] == "message_update"
            && event["assistantMessageEvent"]["type"] == "text_delta"
        {
            delta_counter.fetch_add(1, Ordering::Relaxed);
        }
        let _ = events.send(event);
    });
    let rpc = Rpc::spawn(&executable, &cwd, &[], &args, sink, &[]).await?;
    let result: Result<()> = async {
        let (state, models, commands) = tokio::try_join!(rpc.call("get_state",json!({})),rpc.call("get_available_models",json!({})),rpc.call("get_commands",json!({})))?;
        if state["isStreaming"] != false || models["models"].as_array().is_none_or(|m|m.is_empty()) { bail!("Pi 返回异常状态"); }
        println!("{}",json!({"rustRpc":true,"modelCount":models["models"].as_array().unwrap().len(),"commandCount":commands["commands"].as_array().map(|c|c.len()),"persistedSession":state["sessionFile"].is_string()}));
        if model_test {
            rpc.call("set_auto_retry",json!({"enabled":false})).await?;
            let levels = rpc.call("get_available_thinking_levels",json!({})).await?;
            if let Some(level) = levels["levels"].as_array().and_then(|v|v.first()) { rpc.call("set_thinking_level",json!({"level":level})).await?; }
            rpc.call("prompt",json!({"message":"Reply with exactly PI_TAURI_OK. Do not call tools."})).await?;
            let text = tokio::time::timeout(Duration::from_secs(90), async {
                let mut text = String::new();
                while let Some(event) = receiver.recv().await {
                    if event["type"] == "message_end" && event["message"]["role"] == "assistant" {
                        if let Some(error) = event["message"]["errorMessage"].as_str() { if !error.is_empty() { bail!("{error}"); } }
                        if let Some(blocks) = event["message"]["content"].as_array() { text = blocks.iter().filter_map(|b| if b["type"] == "text" { b["text"].as_str() } else {None}).collect::<Vec<_>>().join(""); }
                    }
                    if event["type"] == "agent_settled" { break; }
                }
                Ok::<_, anyhow::Error>(text)
            }).await??;
            if !text.contains("PI_TAURI_OK") { bail!("Unexpected model response: {text}"); }
            println!("{}",json!({"modelResponse":text,"streamedDeltas":deltas.load(Ordering::Relaxed)}));
        }
        rpc.call("clear_queue",json!({})).await?; rpc.call("abort",json!({})).await?;
        Ok(())
    }.await;
    rpc.stop().await;
    result?;
    println!("Rust Pi RPC verification passed; process exited.");
    Ok(())
}
