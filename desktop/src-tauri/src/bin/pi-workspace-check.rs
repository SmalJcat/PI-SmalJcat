use anyhow::{bail, Context, Result};
use pi_desktop::{
    core::{ConnectOptions, Core},
    workspace,
};
use serde_json::json;
use std::{fs, path::PathBuf, time::Duration};

#[tokio::main]
async fn main() -> Result<()> {
    let model_check = std::env::args().any(|arg| arg == "--model");
    let executable = std::env::var_os("PI_DESKTOP_EXECUTABLE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../pi.exe"));
    let temporary = workspace::canonical(&std::env::temp_dir())?;
    let root = temporary.join(format!("pi-workspace-check-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root)?;
    let work = root.join("work");
    fs::create_dir(&work)?;
    std::env::set_var("PI_DESKTOP_EXECUTABLE", &executable);
    std::env::set_var("PI_DESKTOP_WORKSPACE", &work);
    std::env::set_var("PI_CODING_AGENT_SESSION_DIR", root.join("main-sessions"));
    if !model_check {
        let agent = root.join("agent");
        fs::create_dir(&agent)?;
        fs::write(agent.join("settings.json"),json!({"defaultProvider":"desktop-check","defaultModel":"metadata-only","retry":{"enabled":true},"compaction":{"enabled":true,"modelOverrides":{"desktop-check/metadata-only":{"reserveTokens":30000,"keepRecentTokens":10000}}}}).to_string())?;
        fs::write(agent.join("models.json"),json!({"providers":{"desktop-check":{"api":"openai-completions","baseUrl":"http://127.0.0.1:1/v1","apiKey":"test-only","models":[{"id":"metadata-only","name":"Metadata test","contextWindow":200000,"maxTokens":1024}]}}}).to_string())?;
        std::env::set_var("PI_CODING_AGENT_DIR", &agent);
    }
    let core = Core::new(&root.join("profile"))?;
    let result:Result<()> = async {
        core.connect(ConnectOptions{cwd:Some(work.to_string_lossy().into_owned()),..ConnectOptions::default()}).await?;
        let context=core.context_status().await?;
        if !model_check {
            anyhow::ensure!(context["settings"]["reserveTokens"]==30000,"context settings do not match: {context}");
            let settings_file=core.agent_dir.join("settings.json");let mut external=workspace::read_json(&settings_file)?;
            external["compaction"]["modelOverrides"]["desktop-check/metadata-only"]["reserveTokens"]=45000.into();fs::write(&settings_file,external.to_string())?;
            core.command("set_model",json!({"provider":"desktop-check","modelId":"metadata-only"})).await?;
            anyhow::ensure!(core.context_status().await?["settings"]["reserveTokens"]==30000,"unreloaded file edits must not change the displayed runtime snapshot");
            core.configure_context(json!({"generation":context["generation"],"modelKey":context["modelKey"],"scope":"global","enabled":false,"reserveTokens":50000,"keepRecentTokens":15000})).await?;
            let next=core.context_status().await?;
            anyhow::ensure!(next["enabled"]==false&&next["settings"]["reserveTokens"]==50000&&next["settings"]["keepRecentTokens"]==15000,"runtime settings did not reload: {next}");
            let saved=workspace::read_json(&core.agent_dir.join("settings.json"))?;
            anyhow::ensure!(saved["retry"]["enabled"]==true);
            core.connect(ConnectOptions{cwd:Some(work.to_string_lossy().into_owned()),trust:true,..ConnectOptions::default()}).await?;
            let trusted=core.context_status().await?;anyhow::ensure!(trusted["settings"]["projectTrusted"]==true);
            core.configure_context(json!({"generation":trusted["generation"],"modelKey":trusted["modelKey"],"scope":"project","enabled":true,"reserveTokens":60000,"keepRecentTokens":12000})).await?;
            let project=core.context_status().await?;anyhow::ensure!(project["enabled"]==true&&project["settings"]["reserveTokens"]==60000);
            let global=workspace::read_json(&core.agent_dir.join("settings.json"))?;anyhow::ensure!(global["compaction"]["modelOverrides"]["desktop-check/metadata-only"]["reserveTokens"]==50000);
            anyhow::ensure!(core.configure_context(json!({"generation":project["generation"],"modelKey":project["modelKey"],"scope":"global","enabled":true,"reserveTokens":100,"keepRecentTokens":100})).await.is_err());
            println!("{}",json!({"contextSettings":true,"runtimeReloaded":true,"projectOverride":true,"globalPreserved":true,"unrelatedSettingsPreserved":true,"modelRequests":0,"isolatedConfiguration":true}));
        }else{
            let created=core.agent_action(json!({"action":"start","tasks":["Reply with exactly PI_DESKTOP_AGENT_OK. Do not call tools. This is a short read-only transport verification."]})).await?;
            let id=created["tasks"][0]["id"].as_str().context("task ID missing")?;
            tokio::time::timeout(Duration::from_secs(15),async{while core.agents.pids().is_empty(){tokio::time::sleep(Duration::from_millis(20)).await;}}).await.context("scout process did not start")?;
            core.command("set_session_name",json!({"name":"Isolated parent and scout verification"})).await.context("main session rejected a managed scout process")?;
            let completed=tokio::time::timeout(Duration::from_secs(150),async{
                loop{let task=core.agents.detail(id)?;match task["status"].as_str().unwrap_or_default(){"completed"=>return Ok(task),"failed"|"cancelled"|"interrupted"=>bail!("{task}"),_=>tokio::time::sleep(Duration::from_millis(200)).await}}
            }).await.context("real scout timed out")??;
            anyhow::ensure!(completed["output"].as_str().is_some_and(|output|output.contains("PI_DESKTOP_AGENT_OK")),"unexpected task output");
            println!("{}",json!({"realScout":true,"status":completed["status"],"model":completed["model"],"usage":completed["usage"],"modelRequests":1,"sessionPersisted":completed["sessionPath"].as_str().is_some_and(|p|std::path::Path::new(p).is_file())}));
        }
        Ok(())
    }.await;
    core.shutdown().await;
    if workspace::canonical(&root)?.parent() == Some(temporary.as_path()) {
        fs::remove_dir_all(&root)?;
    } else {
        bail!("temporary profile escaped its parent; cleanup refused");
    }
    result
}
