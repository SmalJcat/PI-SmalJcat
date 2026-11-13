use crate::mcp_client::{McpSession, ServerRequestError};
use anyhow::{anyhow, bail, Result};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::Mutex as AsyncMutex;

pub(crate) const MAX_APP_SUBSCRIPTIONS: usize = 64;
const MAX_CONNECTION_SUBSCRIPTIONS: usize = 256;

#[derive(Clone, Debug)]
pub(crate) enum ResourceEvent {
    Updated(String),
    ListChanged,
    Closed,
}

#[derive(Default)]
struct Subscription {
    owners: BTreeSet<String>,
    confirmed: bool,
}

#[derive(Default)]
pub(crate) struct Subscriptions {
    operations: AsyncMutex<()>,
    entries: Mutex<BTreeMap<String, Subscription>>,
}

impl Subscriptions {
    pub fn owns(&self, owner: &str, uri: &str) -> bool {
        self.entries
            .lock()
            .unwrap()
            .get(uri)
            .is_some_and(|entry| entry.owners.contains(owner))
    }

    pub fn uris(&self, owner: &str) -> Vec<String> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, entry)| entry.owners.contains(owner))
            .map(|(uri, _)| uri.clone())
            .collect()
    }

    pub fn clear(&self) {
        self.entries.lock().unwrap().clear();
    }

    pub async fn subscribe(
        &self,
        session: &McpSession,
        owner: &str,
        uri: &str,
        permit: &AtomicBool,
    ) -> Result<()> {
        let _operation = self.operations.lock().await;
        if !session.connected() || !permit.load(Ordering::SeqCst) {
            bail!("App 或 MCP 连接已关闭");
        }
        let (existing, request) = {
            let mut entries = self.entries.lock().unwrap();
            let existing = entries
                .get(uri)
                .is_some_and(|entry| entry.owners.contains(owner));
            if !existing
                && entries
                    .values()
                    .filter(|entry| entry.owners.contains(owner))
                    .count()
                    >= MAX_APP_SUBSCRIPTIONS
            {
                bail!("App 资源订阅超过 64 个");
            }
            if !entries.contains_key(uri) && entries.len() >= MAX_CONNECTION_SUBSCRIPTIONS {
                bail!("MCP 连接资源订阅超过 256 个，请先取消已有订阅");
            }
            let entry = entries.entry(uri.to_owned()).or_default();
            entry.owners.insert(owner.to_owned());
            (existing, !entry.confirmed)
        };
        if request {
            if let Err(error) = session
                .resource_control("resources/subscribe", uri, Some(permit), None)
                .await
            {
                let mut entries = self.entries.lock().unwrap();
                if !session.connected() {
                    entries.clear();
                } else if let Some(entry) = entries.get_mut(uri) {
                    if !existing {
                        entry.owners.remove(owner);
                    }
                    entry.confirmed = false;
                    if entry.owners.is_empty()
                        && error.downcast_ref::<ServerRequestError>().is_some()
                    {
                        entries.remove(uri);
                    }
                }
                return Err(error);
            }
            if let Some(entry) = self.entries.lock().unwrap().get_mut(uri) {
                entry.confirmed = true;
            }
        }
        if !permit.load(Ordering::SeqCst) || !session.connected() {
            let released = self.remove_owner(owner);
            let _ = self.cleanup_empty(session, &released).await;
            bail!("App 或 MCP 连接已关闭");
        }
        Ok(())
    }

    pub async fn unsubscribe(
        &self,
        session: &McpSession,
        owner: &str,
        uri: &str,
        permit: &AtomicBool,
    ) -> Result<()> {
        let _operation = self.operations.lock().await;
        if !session.connected() || !permit.load(Ordering::SeqCst) {
            bail!("App 或 MCP 连接已关闭");
        }
        let confirmed = {
            let mut entries = self.entries.lock().unwrap();
            let Some(entry) = entries.get_mut(uri) else {
                return Ok(());
            };
            if !entry.owners.remove(owner) || !entry.owners.is_empty() {
                return Ok(());
            }
            entry.confirmed
        };
        match session
            .resource_control("resources/unsubscribe", uri, Some(permit), None)
            .await
        {
            Ok(()) => {
                self.entries.lock().unwrap().remove(uri);
                Ok(())
            }
            Err(error) => {
                let mut entries = self.entries.lock().unwrap();
                if !session.connected() {
                    entries.clear();
                } else if let Some(entry) = entries.get_mut(uri) {
                    if permit.load(Ordering::SeqCst) {
                        entry.owners.insert(owner.to_owned());
                    }
                    entry.confirmed =
                        confirmed && error.downcast_ref::<ServerRequestError>().is_some();
                }
                Err(error)
            }
        }
    }

    fn remove_owner(&self, owner: &str) -> Vec<String> {
        self.entries
            .lock()
            .unwrap()
            .iter_mut()
            .filter_map(|(uri, entry)| {
                (entry.owners.remove(owner) && entry.owners.is_empty()).then(|| uri.clone())
            })
            .collect()
    }

    pub async fn release(&self, session: &McpSession, owner: &str) -> Result<()> {
        let _operation = self.operations.lock().await;
        let released = self.remove_owner(owner);
        self.cleanup_empty(session, &released).await
    }

    async fn cleanup_empty(&self, session: &McpSession, preferred: &[String]) -> Result<()> {
        if !session.connected() {
            self.clear();
            return Ok(());
        }
        let mut uris = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, entry)| entry.owners.is_empty())
            .map(|(uri, _)| uri.clone())
            .collect::<Vec<_>>();
        uris.sort_by_key(|uri| !preferred.contains(uri));
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut errors = Vec::new();
        for uri in uris {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                errors.push("资源订阅清理超过 3 秒".to_owned());
                break;
            }
            match session
                .resource_control("resources/unsubscribe", &uri, None, Some(remaining))
                .await
            {
                Ok(()) => {
                    self.entries.lock().unwrap().remove(&uri);
                }
                Err(error) => {
                    if let Some(entry) = self.entries.lock().unwrap().get_mut(&uri) {
                        entry.confirmed = false;
                    }
                    errors.push(format!("{uri}: {error:#}"));
                }
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(anyhow!(errors.join("\n")))
        }
    }
}

pub(crate) fn validate_uri(uri: &str) -> Result<()> {
    if uri.is_empty()
        || uri.len() > 4096
        || uri.bytes().any(|byte| byte <= 0x20 || byte == 0x7f)
        || url::Url::parse(uri).is_err()
    {
        bail!("资源 URI 必须为不超过 4096 字节的绝对 URI");
    }
    Ok(())
}
