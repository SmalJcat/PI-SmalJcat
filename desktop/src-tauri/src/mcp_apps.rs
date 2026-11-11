//! MCP Apps 沙箱宿主（路线图 P1.2b）。
//!
//! 目标：让 MCP 服务器提供的 widget 能显示，但**不能**直接触达宿主能力。
//! 宿主侧只暴露一份固定白名单（沿用 ChatGPT 桌面端逆向观察到的 12 项基础 + 7 项扩展），
//! 默认拒绝：widget 请求的能力必须由使用者显式授权，未知能力一律不认。
//!
//! 消息从不可信的 widget 进来，因此这里的校验是权威判定：
//! 版本标记、大小上限、字段白名单、原型污染键、调用方授权集合，缺一不可。

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

/// 从 widget 发往宿主的消息版本标记。
pub const MESSAGE_VERSION: u64 = 1;
/// 单条消息上限（字节）。
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// 单次调用载荷上限（字节）。
pub const MAX_PAYLOAD_BYTES: usize = 32 * 1024;
/// 审计日志保留条数。
pub const AUDIT_CAPACITY: usize = 200;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// 白名单条目：能力名、风险级别与说明。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct WidgetApi {
    pub name: &'static str,
    pub risk: &'static str,
    pub note: &'static str,
    /// 只有显式授权后才可用；扩展能力默认不授予。
    pub extended: bool,
}

/// 基础能力：widget 常规渲染与数据回填需要。
pub const BASE_APIS: [WidgetApi; 12] = [
    WidgetApi {
        name: "navigate",
        risk: "medium",
        note: "在宿主内切换页面",
        extended: false,
    },
    WidgetApi {
        name: "notifyMcpAppsHostContext",
        risk: "low",
        note: "上报宿主上下文变化",
        extended: false,
    },
    WidgetApi {
        name: "notifyMcpAppsToolCancelled",
        risk: "low",
        note: "上报工具调用被取消",
        extended: false,
    },
    WidgetApi {
        name: "notifyMcpAppsToolInput",
        risk: "low",
        note: "上报工具输入变化",
        extended: false,
    },
    WidgetApi {
        name: "notifyMcpAppsToolResult",
        risk: "low",
        note: "上报工具结果",
        extended: false,
    },
    WidgetApi {
        name: "requestMcpAppsResourceTeardown",
        risk: "medium",
        note: "请求释放资源",
        extended: false,
    },
    WidgetApi {
        name: "runWidgetCode",
        risk: "medium",
        note: "在 widget 内执行代码",
        extended: false,
    },
    WidgetApi {
        name: "setAdditionalGlobals",
        risk: "medium",
        note: "注入额外全局变量",
        extended: false,
    },
    WidgetApi {
        name: "setSafeArea",
        risk: "low",
        note: "设置安全区域",
        extended: false,
    },
    WidgetApi {
        name: "setTheme",
        risk: "low",
        note: "设置主题",
        extended: false,
    },
    WidgetApi {
        name: "setWidgetData",
        risk: "low",
        note: "写入 widget 数据",
        extended: false,
    },
    WidgetApi {
        name: "setWidgetView",
        risk: "low",
        note: "切换 widget 视图",
        extended: false,
    },
];

/// 扩展能力：默认不授予，逐项由使用者决定。
pub const EXTENDED_APIS: [WidgetApi; 7] = [
    WidgetApi {
        name: "applyAutofillCandidate",
        risk: "high",
        note: "自动填充候选值",
        extended: true,
    },
    WidgetApi {
        name: "getCurrentPath",
        risk: "high",
        note: "读取当前路径",
        extended: true,
    },
    WidgetApi {
        name: "notifyMcpAppsMcpNotification",
        risk: "high",
        note: "转发 MCP 通知",
        extended: true,
    },
    WidgetApi {
        name: "prepareEnvironment",
        risk: "high",
        note: "准备执行环境",
        extended: true,
    },
    WidgetApi {
        name: "runUserCode",
        risk: "high",
        note: "执行用户代码",
        extended: true,
    },
    WidgetApi {
        name: "screenshot",
        risk: "high",
        note: "截取界面",
        extended: true,
    },
    WidgetApi {
        name: "stop",
        risk: "high",
        note: "中止当前任务",
        extended: true,
    },
];

/// 全部白名单条目。
pub fn catalog() -> Vec<WidgetApi> {
    BASE_APIS
        .iter()
        .chain(EXTENDED_APIS.iter())
        .copied()
        .collect()
}

/// 单个能力是否在白名单内。
pub fn is_known_api(name: &str) -> bool {
    catalog().iter().any(|api| api.name == name)
}

/// 授权结果：允许 / 未授权 / 未知。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantEvaluation {
    pub allowed: Vec<String>,
    pub denied: Vec<String>,
    pub unknown: Vec<String>,
}

/// 计算授权结果。deny-by-default：请求了但没授予的能力进 denied，不在白名单的进 unknown。
pub fn evaluate_grants(requested: &[String], granted: &[String]) -> GrantEvaluation {
    let mut allowed = Vec::new();
    let mut denied = Vec::new();
    let mut unknown = Vec::new();
    for name in requested {
        if !is_known_api(name) {
            if !unknown.contains(name) {
                unknown.push(name.clone());
            }
            continue;
        }
        if granted.iter().any(|value| value == name) {
            if !allowed.contains(name) {
                allowed.push(name.clone());
            }
        } else if !denied.contains(name) {
            denied.push(name.clone());
        }
    }
    allowed.sort();
    denied.sort();
    unknown.sort();
    GrantEvaluation {
        allowed,
        denied,
        unknown,
    }
}

/// 为 widget 生成稳定的窗口标签。Tauri 标签只接受字母数字与 -/:/_，
/// 因此把 id 归一化并附加短哈希，避免不同 id 归一化后相撞。
pub fn window_label(widget: &str) -> String {
    let mut slug: String = widget
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    slug = slug.trim_matches('-').chars().take(32).collect();
    let digest = Sha256::digest(widget.as_bytes());
    let suffix = format!("{digest:x}");
    format!("widget-{slug}-{}", &suffix[..8])
}

/// 被禁止的键名：出现在消息任何层级都直接拒绝，避免原型污染类问题。
const FORBIDDEN_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

fn has_forbidden_key(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(key, nested)| {
            FORBIDDEN_KEYS.contains(&key.as_str()) || has_forbidden_key(nested)
        }),
        Value::Array(items) => items.iter().any(has_forbidden_key),
        _ => false,
    }
}

/// 从 widget 进入宿主的一次调用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetCall {
    pub id: String,
    pub api: String,
    #[serde(default)]
    pub payload: Value,
}

/// 校验来自 widget 的消息文本（未经解析的原始字符串）。
pub fn validate_from_widget(raw: &str, granted: &[String]) -> Result<WidgetCall> {
    if raw.len() > MAX_MESSAGE_BYTES {
        bail!("消息过大（{} 字节，上限 {MAX_MESSAGE_BYTES}）", raw.len());
    }
    let value: Value = serde_json::from_str(raw).context("消息不是合法 JSON")?;
    let object = value.as_object().context("消息必须是 JSON 对象")?;
    if has_forbidden_key(&value) {
        bail!("消息包含被禁止的字段名");
    }
    match object.get("pi").and_then(|value| value.as_u64()) {
        Some(MESSAGE_VERSION) => {}
        Some(other) => bail!("不支持的消息版本：{other}"),
        None => bail!("消息缺少版本标记 pi"),
    }
    let id = object
        .get("id")
        .and_then(|value| value.as_str())
        .context("消息缺少调用 id")?
        .to_owned();
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        bail!("调用 id 非法");
    }
    let api = object
        .get("api")
        .and_then(|value| value.as_str())
        .context("消息缺少 api")?
        .to_owned();
    if !is_known_api(&api) {
        bail!("widget 请求了白名单之外的能力：{api}");
    }
    if !granted.iter().any(|value| value == &api) {
        bail!("widget 未获授权调用：{api}");
    }
    let payload = object.get("payload").cloned().unwrap_or_else(|| json!({}));
    let payload_size = payload.to_string().len();
    if payload_size > MAX_PAYLOAD_BYTES {
        bail!("调用载荷过大（{payload_size} 字节，上限 {MAX_PAYLOAD_BYTES}）");
    }
    Ok(WidgetCall { id, api, payload })
}

/// 审计日志的一条记录。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub at_ms: u64,
    pub api: String,
    pub ok: bool,
    pub detail: String,
}

/// 宿主会话：授权集合 + 审计。
pub struct WidgetHost {
    grants: Mutex<BTreeMap<String, Vec<String>>>,
    /// 窗口标签 -> widget id，用于把调用方限定回它自己的会话。
    labels: Mutex<BTreeMap<String, String>>,
    audit: Mutex<VecDeque<AuditEntry>>,
}

impl Default for WidgetHost {
    fn default() -> Self {
        Self::new()
    }
}

impl WidgetHost {
    pub fn new() -> Self {
        Self {
            grants: Mutex::new(BTreeMap::new()),
            labels: Mutex::new(BTreeMap::new()),
            audit: Mutex::new(VecDeque::new()),
        }
    }

    /// 登记一个 widget 会话：请求的能力经过白名单与授权计算后落入会话表。
    pub fn open(&self, widget: &str, requested: &[String], granted: &[String]) -> Value {
        let evaluation = evaluate_grants(requested, granted);
        self.grants
            .lock()
            .unwrap()
            .insert(widget.to_owned(), evaluation.allowed.clone());
        self.labels
            .lock()
            .unwrap()
            .insert(window_label(widget), widget.to_owned());
        self.record(
            widget,
            &format!("open:{}", evaluation.allowed.join(",")),
            true,
            "会话已建立",
        );
        json!({
            "widget": widget,
            "requested": requested,
            "granted": granted,
            "allowed": evaluation.allowed,
            "denied": evaluation.denied,
            "unknown": evaluation.unknown,
        })
    }

    /// 当前会话已授权的能力。
    pub fn allowed(&self, widget: &str) -> Vec<String> {
        self.grants
            .lock()
            .unwrap()
            .get(widget)
            .cloned()
            .unwrap_or_default()
    }

    /// 由窗口标签反查 widget id：调用方只能操作自己的会话。
    pub fn widget_for_label(&self, label: &str) -> Option<String> {
        self.labels.lock().unwrap().get(label).cloned()
    }

    pub fn close(&self, widget: &str) -> Value {
        self.labels.lock().unwrap().remove(&window_label(widget));
        let removed = self.grants.lock().unwrap().remove(widget).is_some();
        self.record(
            widget,
            "close",
            removed,
            if removed {
                "会话已关闭"
            } else {
                "会话不存在"
            },
        );
        json!({ "closed": removed, "widget": widget })
    }

    /// 校验并记录一次来自 widget 的调用。
    pub fn dispatch(&self, widget: &str, raw: &str) -> Value {
        let granted = self.allowed(widget);
        match validate_from_widget(raw, &granted) {
            Ok(call) => {
                self.record(widget, &call.api, true, &format!("id={}", call.id));
                json!({
                    "ok": true,
                    "id": call.id,
                    "api": call.api,
                    "result": mock_result(&call),
                })
            }
            Err(error) => {
                let detail = format!("{error:#}");
                let api = serde_json::from_str::<Value>(raw)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("api")
                            .and_then(|api| api.as_str())
                            .map(str::to_owned)
                    })
                    .unwrap_or_else(|| "(无法解析)".to_owned());
                self.record(widget, &api, false, &detail);
                json!({ "ok": false, "api": api, "error": detail })
            }
        }
    }

    fn record(&self, widget: &str, api: &str, ok: bool, detail: &str) {
        let mut audit = self.audit.lock().unwrap();
        while audit.len() >= AUDIT_CAPACITY {
            audit.pop_front();
        }
        audit.push_back(AuditEntry {
            at_ms: now_ms(),
            api: format!("{widget}::{api}"),
            ok,
            detail: detail.chars().take(300).collect(),
        });
    }

    /// 最近若干条审计记录（新的在前）。
    pub fn audit(&self, limit: usize) -> Vec<AuditEntry> {
        let audit = self.audit.lock().unwrap();
        audit
            .iter()
            .rev()
            .take(limit.clamp(1, AUDIT_CAPACITY))
            .cloned()
            .collect()
    }
}

/// 沙箱里没有真实宿主能力，这里返回可预期的占位结果，便于演示与测试。
fn mock_result(call: &WidgetCall) -> Value {
    match call.api.as_str() {
        "getCurrentPath" => json!({ "path": "（沙箱演示）" }),
        "setTheme" => {
            json!({ "theme": call.payload.get("theme").cloned().unwrap_or_else(|| json!("dark")) })
        }
        "setWidgetData" => json!({ "accepted": true }),
        "notifyMcpAppsToolInput" | "notifyMcpAppsToolResult" | "notifyMcpAppsHostContext" => {
            json!({ "notified": true })
        }
        _ => json!({ "accepted": true }),
    }
}

/// 演示用 widget 目录：不依赖任何外部 MCP 服务器。
pub fn fixture_catalog() -> Value {
    json!({
        "apis": catalog().iter().map(|api| json!({
            "name": api.name,
            "risk": api.risk,
            "note": api.note,
            "extended": api.extended,
        })).collect::<Vec<_>>(),
        "widgets": [
            {
                "id": "fixture.weather",
                "title": "示例 widget：天气卡片",
                "source": "内置夹具",
                "requested": ["setWidgetData", "setTheme", "notifyMcpAppsToolResult"],
            },
            {
                "id": "fixture.autofill",
                "title": "示例 widget：自动填充（高风险）",
                "source": "内置夹具",
                "requested": ["setWidgetData", "getCurrentPath", "applyAutofillCandidate"],
            },
        ],
        "limits": {
            "maxMessageBytes": MAX_MESSAGE_BYTES,
            "maxPayloadBytes": MAX_PAYLOAD_BYTES,
            "auditCapacity": AUDIT_CAPACITY,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_covers_base_and_extended_without_duplicates() {
        let all = catalog();
        assert_eq!(all.len(), 19);
        assert_eq!(all.iter().filter(|api| api.extended).count(), 7);
        let mut names: Vec<&str> = all.iter().map(|api| api.name).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 19, "白名单不应有重复条目");
        for api in &all {
            assert!(
                ["low", "medium", "high"].contains(&api.risk),
                "{}",
                api.name
            );
            assert!(!api.note.is_empty(), "{}", api.name);
        }
        assert!(is_known_api("setTheme"));
        assert!(!is_known_api("execShell"));
    }

    #[test]
    fn grants_are_deny_by_default() {
        let requested = vec![
            "setTheme".to_owned(),
            "runUserCode".to_owned(),
            "dropTables".to_owned(),
        ];
        let granted = vec!["runUserCode".to_owned()];
        let evaluation = evaluate_grants(&requested, &granted);
        assert_eq!(evaluation.allowed, vec!["runUserCode"]);
        assert_eq!(evaluation.denied, vec!["setTheme"]);
        assert_eq!(evaluation.unknown, vec!["dropTables"]);

        // 什么都不授予时全部进 denied
        let evaluation = evaluate_grants(&["setTheme".to_owned()], &[]);
        assert!(evaluation.allowed.is_empty());
        assert_eq!(evaluation.denied, vec!["setTheme"]);
    }

    #[test]
    fn widget_messages_are_validated_strictly() {
        let granted = vec!["setTheme".to_owned()];
        let good = r#"{"pi":1,"id":"c1","api":"setTheme","payload":{"theme":"dark"}}"#;
        let call = validate_from_widget(good, &granted).unwrap();
        assert_eq!(call.id, "c1");
        assert_eq!(call.api, "setTheme");

        // 版本 / id / api / 授权
        assert!(validate_from_widget(r#"{"id":"c1","api":"setTheme"}"#, &granted).is_err());
        assert!(validate_from_widget(r#"{"pi":2,"id":"c1","api":"setTheme"}"#, &granted).is_err());
        assert!(validate_from_widget(r#"{"pi":1,"id":"","api":"setTheme"}"#, &granted).is_err());
        assert!(validate_from_widget(r#"{"pi":1,"id":"a b","api":"setTheme"}"#, &granted).is_err());
        assert!(
            validate_from_widget(r#"{"pi":1,"id":"c1","api":"runUserCode"}"#, &granted).is_err()
        );
        assert!(validate_from_widget("not json", &granted).is_err());
        assert!(validate_from_widget("[1,2]", &granted).is_err());

        // 未授权的已知能力被拒绝
        let error =
            validate_from_widget(r#"{"pi":1,"id":"c1","api":"navigate"}"#, &granted).unwrap_err();
        assert!(error.to_string().contains("未获授权"), "{error}");
    }

    #[test]
    fn prototype_pollution_keys_are_rejected_at_any_depth() {
        let granted = vec!["setTheme".to_owned()];
        for raw in [
            r#"{"pi":1,"id":"c1","api":"setTheme","payload":{"__proto__":{"polluted":true}}}"#,
            r#"{"pi":1,"id":"c1","api":"setTheme","payload":{"a":[{"constructor":{}}]}}"#,
            r#"{"pi":1,"id":"c1","api":"setTheme","prototype":{}}"#,
        ] {
            let error = validate_from_widget(raw, &granted).unwrap_err();
            assert!(
                error.to_string().contains("被禁止的字段名"),
                "{raw} -> {error}"
            );
        }
    }

    #[test]
    fn oversized_messages_and_payloads_are_rejected() {
        let granted = vec!["setTheme".to_owned()];
        let huge = format!(
            r#"{{"pi":1,"id":"c1","api":"setTheme","payload":{{"text":"{}"}}}}"#,
            "x".repeat(MAX_PAYLOAD_BYTES + 100)
        );
        assert!(validate_from_widget(&huge, &granted).is_err());

        let too_big = "y".repeat(MAX_MESSAGE_BYTES + 1);
        let error = validate_from_widget(&too_big, &granted).unwrap_err();
        assert!(error.to_string().contains("消息过大"), "{error}");
    }

    #[test]
    fn host_tracks_sessions_and_audits_every_call() {
        let host = WidgetHost::new();
        let opened = host.open(
            "fixture.weather",
            &["setWidgetData".to_owned(), "runUserCode".to_owned()],
            &["setWidgetData".to_owned()],
        );
        assert_eq!(opened["allowed"][0], "setWidgetData");
        assert_eq!(opened["denied"][0], "runUserCode");
        assert_eq!(host.allowed("fixture.weather"), vec!["setWidgetData"]);

        let allowed = host.dispatch(
            "fixture.weather",
            r#"{"pi":1,"id":"c1","api":"setWidgetData","payload":{"value":1}}"#,
        );
        assert!(allowed["ok"].as_bool().unwrap_or(false));
        assert_eq!(allowed["result"]["accepted"], true);

        let denied = host.dispatch(
            "fixture.weather",
            r#"{"pi":1,"id":"c2","api":"runUserCode","payload":{}}"#,
        );
        assert!(!denied["ok"].as_bool().unwrap_or(true));
        assert!(denied["error"].as_str().unwrap().contains("未获授权"));

        let unknown_api = host.dispatch(
            "fixture.weather",
            r#"{"pi":1,"id":"c3","api":"rmDashRf","payload":{}}"#,
        );
        assert!(!unknown_api["ok"].as_bool().unwrap_or(true));
        assert!(unknown_api["error"]
            .as_str()
            .unwrap()
            .contains("白名单之外"));

        // 审计：open + 3 次调用，最新在前
        let audit = host.audit(10);
        assert_eq!(audit.len(), 4);
        assert!(!audit[0].ok);
        assert!(audit[0].api.contains("rmDashRf"));

        // 未登记的会话没有任何授权
        assert!(host.allowed("nobody").is_empty());
        assert_eq!(
            host.dispatch("nobody", r#"{"pi":1,"id":"c1","api":"setTheme"}"#)["ok"],
            false
        );

        assert!(host.close("fixture.weather")["closed"]
            .as_bool()
            .unwrap_or(false));
        assert!(!host.close("fixture.weather")["closed"]
            .as_bool()
            .unwrap_or(true));
        assert!(host.allowed("fixture.weather").is_empty());
    }

    #[test]
    fn audit_ring_is_bounded() {
        let host = WidgetHost::new();
        host.open("w", &["setTheme".to_owned()], &["setTheme".to_owned()]);
        for index in 0..(AUDIT_CAPACITY + 50) {
            host.dispatch(
                "w",
                &format!(r#"{{"pi":1,"id":"c{index}","api":"setTheme"}}"#),
            );
        }
        let audit = host.audit(AUDIT_CAPACITY * 2);
        assert_eq!(audit.len(), AUDIT_CAPACITY, "审计日志应有上限");
        assert!(host.audit(5).len() <= 5);
    }

    #[test]
    fn window_labels_are_stable_and_safe() {
        let label = window_label("fixture.weather");
        assert!(label.starts_with("widget-fixture-weather-"));
        assert!(label
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-'));
        assert!(label.len() <= 48);
        assert_eq!(
            label,
            window_label("fixture.weather"),
            "同一 id 必须得到同一标签"
        );
        assert_ne!(label, window_label("fixture/weather"), "不同 id 不应相撞");
        assert_ne!(
            window_label(&"a".repeat(200)),
            window_label(&"b".repeat(200))
        );

        let host = WidgetHost::new();
        host.open(
            "fixture.weather",
            &["setTheme".to_owned()],
            &["setTheme".to_owned()],
        );
        assert_eq!(
            host.widget_for_label(&window_label("fixture.weather"))
                .as_deref(),
            Some("fixture.weather")
        );
        assert!(host.widget_for_label("widget-other-00000000").is_none());
        host.close("fixture.weather");
        assert!(host
            .widget_for_label(&window_label("fixture.weather"))
            .is_none());
    }

    #[test]
    fn fixture_catalog_is_self_contained() {
        let catalog = fixture_catalog();
        assert_eq!(catalog["apis"].as_array().unwrap().len(), 19);
        assert_eq!(catalog["widgets"].as_array().unwrap().len(), 2);
        assert_eq!(
            catalog["limits"]["maxMessageBytes"],
            MAX_MESSAGE_BYTES as u64
        );
        // 夹具里声明的高风险能力确实属于扩展集合
        let autofill = &catalog["widgets"][1];
        assert!(autofill["requested"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "applyAutofillCandidate"));
    }
}
