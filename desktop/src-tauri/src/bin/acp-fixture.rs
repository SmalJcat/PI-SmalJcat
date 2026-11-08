//! Deterministic ACP server for transport/UI tests. Never calls a model or executes tools.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{self, BufRead, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};
use uuid::Uuid;

type Output = Arc<Mutex<io::Stdout>>;
#[derive(Default)]
struct State {
    sessions: BTreeMap<String, Value>,
    options: BTreeMap<String, Value>,
    cancel: Arc<AtomicBool>,
    permissions: BTreeMap<String, mpsc::Sender<Value>>,
    history: BTreeMap<String, Vec<Value>>,
}
fn send(out: &Output, value: Value) {
    let mut writer = out.lock().unwrap();
    let _ = writeln!(writer, "{value}");
    let _ = writer.flush();
}
fn reply(out: &Output, id: Value, result: Value) {
    send(out, json!({"jsonrpc":"2.0","id":id,"result":result}));
}
fn update(out: &Output, session: &str, update: Value) {
    send(
        out,
        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":update}}),
    );
}
fn options(model: &str, level: &str, mode: &str) -> Value {
    json!([
        {"id":"model","name":"Model","category":"model","type":"select","currentValue":model,"options":[{"value":"gemini-fixture","name":"Gemini fixture"},{"value":"claude-fixture","name":"Claude fixture"}]},
        {"id":"thought_level","name":"Thinking Level","category":"thought_level","type":"select","currentValue":level,"options":[{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"}]},
        {"id":"mode","name":"Mode","category":"mode","type":"select","currentValue":mode,"options":[{"value":"default","name":"Default"},{"value":"plan","name":"Plan"}]}
    ])
}
fn main() {
    let full_access = std::env::args().any(|argument| argument == "--dangerously-skip-permissions");
    if full_access && std::env::args().any(|argument| argument == "--fail-full-access") {
        std::process::exit(10);
    }
    if !full_access && std::env::args().any(|argument| argument == "--fail-ask") {
        std::process::exit(11);
    }
    let out = Arc::new(Mutex::new(io::stdout()));
    let state = Arc::new(Mutex::new(State::default()));
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let method = message["method"].as_str().unwrap_or_default();
        let id = message["id"].clone();
        let params = &message["params"];
        if method.is_empty() {
            if let Some(tx) = state.lock().unwrap().permissions.remove(&id.to_string()) {
                let _ = tx.send(message["result"].clone());
            }
            continue;
        }
        match method {
            "initialize" => {
                let mut init = json!({"protocolVersion":1,"agentInfo":{"name":"ACP fixture","version":"1"},"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true},"sessionCapabilities":{"list":{},"resume":{}}}});
                if std::env::args().any(|argument| argument == "--no-images") {
                    init["agentCapabilities"]["promptCapabilities"]["image"] = json!(false);
                }
                if std::env::args().any(|argument| argument == "--no-resume") {
                    init["agentCapabilities"]["sessionCapabilities"]
                        .as_object_mut()
                        .unwrap()
                        .remove("resume");
                }
                reply(&out, id, init);
            }
            "session/new" => {
                let sid = Uuid::new_v4().to_string();
                let config = options("gemini-fixture", "medium", "default");
                let mut state = state.lock().unwrap();
                state.sessions.insert(
                    sid.clone(),
                    json!({"sessionId":sid,"cwd":params["cwd"],"title":"ACP fixture session"}),
                );
                state.options.insert(sid.clone(), config.clone());
                reply(&out, id, json!({"sessionId":sid,"configOptions":config}));
            }
            "session/resume" | "session/load" => {
                let sid = params["sessionId"].as_str().unwrap_or_default();
                let mut state = state.lock().unwrap();
                state.sessions.entry(sid.into()).or_insert_with(
                    || json!({"sessionId":sid,"cwd":params["cwd"],"title":"ACP restored"}),
                );
                let config = state
                    .options
                    .entry(sid.into())
                    .or_insert_with(|| options("gemini-fixture", "medium", "default"))
                    .clone();
                let history = state.history.get(sid).cloned().unwrap_or_default();
                drop(state);
                if method == "session/load" {
                    for event in history {
                        update(&out, sid, event);
                    }
                }
                reply(&out, id, json!({"configOptions":config}));
            }
            "session/list" => reply(
                &out,
                id,
                json!({"sessions":state.lock().unwrap().sessions.values().cloned().collect::<Vec<_>>()}),
            ),
            "session/set_config_option" => {
                let mut state = state.lock().unwrap();
                let sid = params["sessionId"].as_str().unwrap_or_default();
                let config = state
                    .options
                    .entry(sid.into())
                    .or_insert_with(|| options("gemini-fixture", "medium", "default"));
                if let Some(items) = config.as_array_mut() {
                    if let Some(option) = items
                        .iter_mut()
                        .find(|item| item["id"] == params["configId"])
                    {
                        option["currentValue"] = params["value"].clone();
                    }
                }
                reply(&out, id, json!({"configOptions":config}));
            }
            "session/cancel" => {
                state.lock().unwrap().cancel.store(true, Ordering::SeqCst);
            }
            "session/prompt" => {
                let image_count = params["prompt"].as_array().map_or(0, |items| {
                    items.iter().filter(|item| item["type"] == "image").count()
                });
                let text = params["prompt"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                if text.contains("[exit]") {
                    std::process::exit(9);
                }
                let session = params["sessionId"].as_str().unwrap_or_default().to_owned();
                state.lock().unwrap().history.entry(session.clone()).or_default().push(json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":text}}));
                let cancelled = Arc::new(AtomicBool::new(false));
                state.lock().unwrap().cancel = cancelled.clone();
                let state = state.clone();
                let out = out.clone();
                thread::spawn(move || {
                    let mut transcript = "ACP 中文".to_owned();
                    if image_count > 0 {
                        transcript.push_str(&format!(" ACP_IMAGE_COUNT:{image_count} "));
                    }
                    update(
                        &out,
                        &session,
                        json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"ACP 独立上下文"}}),
                    );
                    update(
                        &out,
                        &session,
                        json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":transcript}}),
                    );
                    if text.contains("[long]") {
                        for index in 0..64 {
                            if cancelled.load(Ordering::SeqCst) {
                                break;
                            }
                            let part = format!(
                                "\n{index:03} {} https://example.test/{}\n",
                                "长输出🙂".repeat(32),
                                "a".repeat(256)
                            );
                            transcript.push_str(&part);
                            update(
                                &out,
                                &session,
                                json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":part}}),
                            );
                        }
                        transcript.push_str("ACP_LONG_END");
                        update(
                            &out,
                            &session,
                            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ACP_LONG_END"}}),
                        );
                    }
                    let mut suffix = "🙂 完成";
                    if text.contains("[permission]") {
                        let tool_id = Uuid::new_v4().to_string();
                        let permission = Uuid::new_v4().to_string();
                        let (tx, rx) = mpsc::channel();
                        state
                            .lock()
                            .unwrap()
                            .permissions
                            .insert(json!(permission).to_string(), tx.clone());
                        update(
                            &out,
                            &session,
                            json!({"sessionUpdate":"tool_call","toolCallId":tool_id,"title":"测试命令","kind":"execute","status":"pending","rawInput":{"command":"echo ACP_FIXTURE"}}),
                        );
                        if full_access {
                            let _ = tx
                                .send(json!({"outcome":{"outcome":"selected","optionId":"allow"}}));
                        } else {
                            send(
                                &out,
                                json!({"jsonrpc":"2.0","id":permission,"method":"session/request_permission","params":{"sessionId":session,"toolCall":{"toolCallId":tool_id,"title":"测试命令","rawInput":{"command":"echo ACP_FIXTURE"}},"options":[{"optionId":"allow","name":"允许一次","kind":"allow_once"},{"optionId":"reject","name":"拒绝","kind":"reject_once"}]}}),
                            );
                        }
                        let result = loop {
                            if cancelled.load(Ordering::SeqCst) {
                                break None;
                            }
                            match rx.recv_timeout(Duration::from_millis(20)) {
                                Ok(value) => break Some(value),
                                Err(mpsc::RecvTimeoutError::Disconnected) => break None,
                                _ => {}
                            }
                        };
                        suffix = if result
                            .as_ref()
                            .is_some_and(|value| value["outcome"]["optionId"] == "allow")
                        {
                            "ACP_PERMISSION_ALLOWED"
                        } else {
                            "ACP_PERMISSION_DENIED"
                        };
                        update(
                            &out,
                            &session,
                            json!({"sessionUpdate":"tool_call_update","toolCallId":tool_id,"status":"completed","content":[{"type":"content","content":{"type":"text","text":suffix}}]}),
                        );
                    }
                    if text.contains("[wait]") {
                        for _ in 0..1200 {
                            if cancelled.load(Ordering::SeqCst) {
                                break;
                            }
                            thread::sleep(Duration::from_millis(25));
                        }
                    }
                    if text.contains("[hang]") {
                        thread::sleep(Duration::from_secs(60));
                    }
                    thread::sleep(Duration::from_millis(60));
                    if !cancelled.load(Ordering::SeqCst) {
                        state.lock().unwrap().history.entry(session.clone()).or_default().push(json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("{transcript}{suffix}")}}));
                        update(
                            &out,
                            &session,
                            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":suffix}}),
                        );
                    }
                    reply(
                        &out,
                        id,
                        json!({"stopReason":if cancelled.load(Ordering::SeqCst){"cancelled"}else{"end_turn"}}),
                    );
                });
            }
            _ => send(
                &out,
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"unsupported"}}),
            ),
        }
    }
}
