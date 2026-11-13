use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Clone)]
pub(crate) struct Scope {
    pub generation: u64,
    pub edit_revision: u64,
    pub session_id: String,
}

pub(crate) struct Slot {
    scope: Scope,
    id: String,
    source: String,
    current: Box<dyn Fn() -> bool + Send + Sync>,
    value: Mutex<Option<Value>>,
    pub updates: AsyncMutex<()>,
}

impl Slot {
    pub fn current(&self) -> bool {
        (self.current)()
    }

    pub fn set(&self, value: Option<Value>) -> Result<()> {
        let mut stored = self.value.lock().unwrap();
        if !self.current() {
            bail!("App 上下文授权已失效");
        }
        *stored = value.map(|mut value| {
            value["timestamp"] = json!(SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64);
            value
        });
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct Registry(Mutex<BTreeMap<String, Weak<Slot>>>);

impl Registry {
    pub fn register(
        &self,
        id: String,
        source: String,
        scope: Scope,
        current: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Arc<Slot> {
        let slot = Arc::new(Slot {
            scope,
            id: id.clone(),
            source,
            current: Box::new(current),
            value: Mutex::new(None),
            updates: AsyncMutex::new(()),
        });
        let mut entries = self.0.lock().unwrap();
        entries.retain(|_, entry| entry.strong_count() > 0);
        entries.insert(id, Arc::downgrade(&slot));
        slot
    }

    pub fn snapshot(&self, generation: u64, edit_revision: u64, session_id: &str) -> Vec<Value> {
        let mut entries = self.0.lock().unwrap();
        entries.retain(|_, entry| entry.strong_count() > 0);
        entries
            .values()
            .filter_map(Weak::upgrade)
            .filter_map(|slot| {
                if slot.scope.generation != generation
                    || slot.scope.edit_revision != edit_revision
                    || slot.scope.session_id != session_id
                    || !slot.current()
                {
                    return None;
                }
                let mut value = slot.value.lock().unwrap().clone()?;
                value["id"] = json!(slot.id);
                value["source"] = json!(slot.source);
                Some(value)
            })
            .collect()
    }
}

pub(crate) fn parse(payload: &Value) -> Result<Option<Value>> {
    if !payload.is_object() || serde_json::to_vec(payload)?.len() > 64 * 1024 {
        bail!("App 模型上下文格式无效或超过 64 KiB");
    }
    let mut result = Map::new();
    if let Some(content) = payload.get("content") {
        let blocks = content
            .as_array()
            .context("App 上下文 content 必须为数组")?;
        let mut text = Vec::new();
        for block in blocks {
            if block["type"] != "text" {
                bail!("App 上下文只支持文本内容块");
            }
            let value = block["text"].as_str().context("App 上下文文本无效")?;
            if !value.trim().is_empty() {
                text.push(json!({"type":"text","text":value}));
            }
        }
        if !text.is_empty() {
            result.insert("content".into(), json!(text));
        }
    }
    if let Some(structured) = payload.get("structuredContent") {
        if !structured.is_object() {
            bail!("App 上下文 structuredContent 必须为对象");
        }
        result.insert("structuredContent".into(), structured.clone());
    }
    Ok((!result.is_empty()).then_some(Value::Object(result)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn context_payloads_preserve_text_and_structured_data_and_reject_invalid_inputs() {
        let payload = json!({"content":[{"type":"text","text":"你好🙂"}],"structuredContent":{"selected":[1,2]}});
        assert_eq!(parse(&payload).unwrap(), Some(payload));
        assert_eq!(parse(&json!({})).unwrap(), None);
        assert_eq!(parse(&json!({"content":[]})).unwrap(), None);
        for payload in [
            json!([]),
            json!({"content":{}}),
            json!({"content":[{"type":"image","data":"AAEC"}]}),
            json!({"content":[{"type":"text","text":42}]}),
            json!({"structuredContent":[]}),
            json!({"structuredContent":{"large":"x".repeat(64*1024)}}),
        ] {
            assert!(parse(&payload).is_err());
        }
    }

    #[test]
    fn registry_isolates_apps_and_discards_inactive_or_stale_contexts() {
        let registry = Registry::default();
        let scope = Scope {
            generation: 1,
            edit_revision: 0,
            session_id: "session".into(),
        };
        let active = Arc::new(AtomicBool::new(true));
        let permit = active.clone();
        let first = registry.register("a".into(), "first".into(), scope.clone(), move || {
            permit.load(Ordering::SeqCst)
        });
        let second = registry.register("b".into(), "second".into(), scope, || true);
        first
            .set(parse(&json!({"structuredContent":{"old":true}})).unwrap())
            .unwrap();
        first
            .set(parse(&json!({"structuredContent":{"latest":true}})).unwrap())
            .unwrap();
        second
            .set(parse(&json!({"content":[{"type":"text","text":"independent"}]})).unwrap())
            .unwrap();
        let values = registry.snapshot(1, 0, "session");
        assert_eq!(values.len(), 2);
        assert_eq!(values[0]["structuredContent"], json!({"latest":true}));
        assert_eq!(values[1]["source"], "second");
        assert!(registry.snapshot(2, 0, "session").is_empty());
        assert!(registry.snapshot(1, 1, "session").is_empty());
        assert!(registry.snapshot(1, 0, "another").is_empty());
        first.set(None).unwrap();
        assert_eq!(registry.snapshot(1, 0, "session").len(), 1);
        active.store(false, Ordering::SeqCst);
        assert!(first
            .set(parse(&json!({"structuredContent":{}})).unwrap())
            .is_err());
        drop(second);
        assert!(registry.snapshot(1, 0, "session").is_empty());
    }
}
