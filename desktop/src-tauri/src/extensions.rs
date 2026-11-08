//! 扩展清单、权限与签名校验（路线图 P1.1）。
//!
//! 设计目标：桌面端不替 Pi 加载扩展，而是把“这个扩展是谁签的、要什么权限、能不能信”
//! 变成可核查的结论。清单非法或签名不通过一律 fail closed，不进入受信任状态。
//!
//! 载荷格式与 src/extensions.mjs 的 payloadFor() 必须逐字节一致（每行以 LF 结束，末行同样带 LF）：
//!     pi-extension-v1
//!     id=<id>
//!     name=<name>
//!     version=<version>
//!     entry=<entry>
//!     permissions=<按字节序排序并去重，逗号分隔>
//!     pi=<pi 版本要求>
//!     sha256=<entry 文件字节的 SHA-256 小写十六进制>
//! description / homepage 只用于展示，不参与签名。
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path},
};

/// 载荷头，版本化以便将来扩展字段。
pub const PAYLOAD_HEADER: &str = "pi-extension-v1";
/// 允许的权限集合。出现未知权限即视为清单非法（fail closed）。
pub const KNOWN_PERMISSIONS: [&str; 7] = [
    "read",
    "tools",
    "fs:workspace",
    "fs:any",
    "exec",
    "network",
    "secrets",
];
/// 信任库文件名（位于 extensions 根目录）。
pub const TRUST_STORE: &str = "trusted-keys.json";
const DEFAULT_ENTRY: &str = "index.mjs";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

fn default_entry() -> String {
    DEFAULT_ENTRY.to_owned()
}

/// 扩展清单。未列出的字段会被忽略，避免因为厂商自有扩展字段而拒绝加载。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "default_entry")]
    pub entry: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub pi: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
}

/// 签名文件 signature.json。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureFile {
    #[serde(default = "default_algorithm")]
    pub algorithm: String,
    pub key_id: String,
    pub signature: String,
}

fn default_algorithm() -> String {
    "ed25519".to_owned()
}

/// 判定结论。除 Verified 之外都表示“不该信任”。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// 签名有效，且签名密钥在信任库中。
    Verified,
    /// 签名有效，但密钥不在信任库中。
    UntrustedKey,
    /// 有签名但校验失败。
    Invalid,
    /// 没有签名文件。
    Unsigned,
    /// 清单本身不合法，无法进入校验。
    Broken,
}

fn is_valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value.split('.').all(|segment| {
            !segment.is_empty()
                && segment.len() <= 40
                && segment.bytes().all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || byte == b'-'
                        || byte == b'_'
                })
                && segment.as_bytes()[0].is_ascii_alphanumeric()
        })
}

fn is_valid_version(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 32
        && value.starts_with(|c: char| c.is_ascii_digit())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.' || byte == b'-' || byte == b'+')
}

fn is_valid_entry(value: &str) -> bool {
    let path = Path::new(value);
    if path.components().count() != 1 {
        return false;
    }
    if !matches!(path.components().next(), Some(Component::Normal(_))) {
        return false;
    }
    matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("mjs") | Some("js") | Some("cjs")
    )
}

/// 权限去重并按字节序排序，保证签名载荷稳定。
pub fn normalize_permissions(permissions: &[String]) -> Vec<String> {
    let mut values: Vec<String> = permissions
        .iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .collect();
    values.sort();
    values.dedup();
    values
}

/// 解析并校验清单文本。
pub fn parse_manifest(text: &str) -> Result<ExtensionManifest> {
    let manifest: ExtensionManifest =
        serde_json::from_str(text).context("扩展清单不是合法 JSON 或缺少必需字段")?;
    if !is_valid_id(&manifest.id) {
        bail!(
            "扩展 id 非法：{}（只允许小写字母、数字、点、中划线与下划线）",
            manifest.id
        );
    }
    if manifest.name.trim().is_empty() {
        bail!("扩展缺少名称");
    }
    if !is_valid_version(&manifest.version) {
        bail!("扩展版本号非法：{}", manifest.version);
    }
    if !is_valid_entry(&manifest.entry) {
        bail!(
            "扩展入口非法：{}（只允许同级目录下的 .mjs/.js/.cjs）",
            manifest.entry
        );
    }
    for permission in normalize_permissions(&manifest.permissions) {
        if !KNOWN_PERMISSIONS.contains(&permission.as_str()) {
            bail!("扩展声明了未知权限：{permission}");
        }
    }
    Ok(manifest)
}

/// 构造签名载荷。与前端 payloadFor() 保持一致。
pub fn payload(manifest: &ExtensionManifest, entry_sha256: &str) -> String {
    let permissions = normalize_permissions(&manifest.permissions).join(",");
    let mut out = String::new();
    for line in [
        PAYLOAD_HEADER.to_owned(),
        format!("id={}", manifest.id),
        format!("name={}", manifest.name),
        format!("version={}", manifest.version),
        format!("entry={}", manifest.entry),
        format!("permissions={permissions}"),
        format!("pi={}", manifest.pi.clone().unwrap_or_default()),
        format!("sha256={}", entry_sha256.to_ascii_lowercase()),
    ] {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// 入口文件的 SHA-256（小写十六进制）。
pub fn entry_sha256(dir: &Path, entry: &str) -> Result<String> {
    let path = dir.join(entry);
    let bytes = fs::read(&path).with_context(|| format!("无法读取扩展入口 {}", path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

/// 读取信任库：keyId -> base64 公钥。缺失或损坏都返回空表，不阻塞列表。
pub fn load_trust_store(root: &Path) -> BTreeMap<String, String> {
    let file = root.join(TRUST_STORE);
    let Ok(text) = fs::read_to_string(&file) else {
        return BTreeMap::new();
    };
    serde_json::from_str::<BTreeMap<String, String>>(&text).unwrap_or_default()
}

fn verify_signature(key_base64: &str, payload: &[u8], signature_base64: &str) -> Result<()> {
    let key_bytes = BASE64
        .decode(key_base64.trim())
        .context("信任库公钥不是合法 base64")?;
    let key_bytes: [u8; 32] = key_bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("信任库公钥长度不是 32 字节"))?;
    let key = VerifyingKey::from_bytes(&key_bytes).context("信任库公钥不是合法 Ed25519 公钥")?;
    let signature_bytes = BASE64
        .decode(signature_base64.trim())
        .context("签名不是合法 base64")?;
    let signature = Signature::from_slice(&signature_bytes).context("签名长度不是 64 字节")?;
    key.verify(payload, &signature).context("签名与载荷不匹配")
}

/// 单个扩展的判定结果。
pub struct Outcome {
    pub verdict: Verdict,
    pub error: String,
    pub signature: Option<SignatureFile>,
    pub entry_sha256: String,
}

/// 对一个扩展目录做完整判定：清单 -> 入口摘要 -> 签名 -> 信任库。
pub fn verify_extension(dir: &Path, trust_store: &BTreeMap<String, String>) -> Outcome {
    let mut outcome = Outcome {
        verdict: Verdict::Broken,
        error: String::new(),
        signature: None,
        entry_sha256: String::new(),
    };
    let manifest_path = dir.join("manifest.json");
    let Ok(metadata) = fs::metadata(&manifest_path) else {
        outcome.error = "缺少 manifest.json".into();
        return outcome;
    };
    if metadata.len() > MAX_MANIFEST_BYTES {
        outcome.error = "manifest.json 过大".into();
        return outcome;
    }
    let Ok(text) = fs::read_to_string(&manifest_path) else {
        outcome.error = "manifest.json 不是 UTF-8 文本".into();
        return outcome;
    };
    let manifest = match parse_manifest(&text) {
        Ok(manifest) => manifest,
        Err(error) => {
            outcome.error = format!("{error:#}");
            return outcome;
        }
    };
    outcome.entry_sha256 = match entry_sha256(dir, &manifest.entry) {
        Ok(digest) => digest,
        Err(error) => {
            outcome.error = format!("{error:#}");
            return outcome;
        }
    };
    let signature_path = dir.join("signature.json");
    if !signature_path.is_file() {
        outcome.verdict = Verdict::Unsigned;
        return outcome;
    }
    let signature = match fs::read_to_string(&signature_path)
        .context("signature.json 不可读")
        .and_then(|text| {
            serde_json::from_str::<SignatureFile>(&text).context("signature.json 格式无效")
        }) {
        Ok(signature) => signature,
        Err(error) => {
            outcome.error = format!("{error:#}");
            return outcome;
        }
    };
    if !signature.algorithm.eq_ignore_ascii_case("ed25519") {
        outcome.error = format!("不支持的签名算法：{}", signature.algorithm);
        return outcome;
    }
    outcome.signature = Some(signature.clone());
    let payload = payload(&manifest, &outcome.entry_sha256);
    let Some(public_key) = trust_store.get(&signature.key_id) else {
        outcome.verdict = Verdict::UntrustedKey;
        return outcome;
    };
    match verify_signature(public_key, payload.as_bytes(), &signature.signature) {
        Ok(()) => outcome.verdict = Verdict::Verified,
        Err(error) => {
            outcome.verdict = Verdict::Invalid;
            outcome.error = format!("{error:#}");
        }
    }
    outcome
}

/// 扫描 extensions 根目录并返回可直接给界面用的列表。
pub fn scan(root: &Path) -> Value {
    let trust_store = load_trust_store(root);
    let mut items = Vec::new();
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let manifest_text = fs::read_to_string(path.join("manifest.json")).unwrap_or_default();
            let manifest: Option<ExtensionManifest> = parse_manifest(&manifest_text).ok();
            let outcome = verify_extension(&path, &trust_store);
            let directory = path
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default();
            let (id, name, version, entry_name, permissions, description, pi, homepage) =
                match &manifest {
                    Some(manifest) => (
                        manifest.id.clone(),
                        manifest.name.clone(),
                        manifest.version.clone(),
                        manifest.entry.clone(),
                        normalize_permissions(&manifest.permissions),
                        manifest.description.clone(),
                        manifest.pi.clone(),
                        manifest.homepage.clone(),
                    ),
                    None => (
                        directory.clone(),
                        String::new(),
                        String::new(),
                        String::new(),
                        Vec::new(),
                        None,
                        None,
                        None,
                    ),
                };
            items.push(json!({
                "id": id,
                "name": name,
                "version": version,
                "entry": entry_name,
                "permissions": permissions,
                "description": description,
                "pi": pi,
                "homepage": homepage,
                "directory": directory,
                "path": path.to_string_lossy(),
                "verdict": outcome.verdict,
                "error": outcome.error,
                "signature": outcome.signature.as_ref().map(|signature| json!({
                    "algorithm": signature.algorithm,
                    "keyId": signature.key_id,
                })),
                "entrySha256": outcome.entry_sha256,
            }));
        }
    }
    items.sort_by(|left, right| {
        left["id"]
            .as_str()
            .unwrap_or_default()
            .cmp(right["id"].as_str().unwrap_or_default())
    });
    json!({
        "root": root.to_string_lossy(),
        "trustedKeys": trust_store.keys().cloned().collect::<Vec<_>>(),
        "extensions": items,
    })
}

/// 便于将来在桌面端展示：把判定结果映射为界面用语。
pub fn verdict_label(verdict: Verdict) -> &'static str {
    match verdict {
        Verdict::Verified => "已签名并受信任",
        Verdict::UntrustedKey => "签名有效但密钥不受信任",
        Verdict::Invalid => "签名无效",
        Verdict::Unsigned => "未签名",
        Verdict::Broken => "清单无效",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const ENTRY_BODY: &str = "export default () => {};\n";

    fn write_extension(dir: &Path, manifest: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("manifest.json"), manifest).unwrap();
        if !dir.join("index.mjs").exists() {
            fs::write(dir.join("index.mjs"), ENTRY_BODY).unwrap();
        }
    }

    fn manifest_json(id: &str, permissions: &str) -> String {
        format!(
            r#"{{"id":"{id}","name":"示例扩展","version":"1.2.0","entry":"index.mjs","permissions":[{permissions}],"pi":">=1.5.0"}}"#
        )
    }

    /// 固定种子，测试完全确定，不依赖随机数。
    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7_u8; 32])
    }

    fn trust_store_with(key: &SigningKey, key_id: &str) -> BTreeMap<String, String> {
        let mut store = BTreeMap::new();
        store.insert(
            key_id.to_owned(),
            BASE64.encode(key.verifying_key().to_bytes()),
        );
        store
    }

    fn sign(dir: &Path, key: &SigningKey, key_id: &str) {
        let manifest =
            parse_manifest(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        let digest = entry_sha256(dir, &manifest.entry).unwrap();
        let payload = payload(&manifest, &digest);
        let signature = key.sign(payload.as_bytes());
        fs::write(
            dir.join("signature.json"),
            serde_json::to_vec(&serde_json::json!({
                "algorithm": "ed25519",
                "keyId": key_id,
                "signature": BASE64.encode(signature.to_bytes()),
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn manifest_validation_is_strict() {
        assert!(parse_manifest(&manifest_json("com.example.demo", "\"tools\"")).is_ok());
        assert!(parse_manifest(r#"{"id":"com.example.demo"}"#).is_err());
        assert!(parse_manifest(&manifest_json("Com.Example", "[]")).is_err());
        assert!(parse_manifest(&manifest_json("../evil", "[]")).is_err());
        assert!(parse_manifest(
            r#"{"id":"com.example.demo","name":"x","version":"v1","entry":"index.mjs"}"#
        )
        .is_err());
        // 未知权限必须失败，而不是被忽略
        assert!(parse_manifest(&manifest_json("com.example.demo", "\"root\"")).is_err());
        assert!(parse_manifest(
            r#"{"id":"com.example.demo","name":"x","version":"1.0.0","entry":"sub/index.mjs"}"#
        )
        .is_err());
        assert!(parse_manifest(
            r#"{"id":"com.example.demo","name":"x","version":"1.0.0","entry":"index.exe"}"#
        )
        .is_err());
    }

    #[test]
    fn permissions_are_sorted_and_deduplicated() {
        let manifest = parse_manifest(&manifest_json(
            "com.example.demo",
            "\"tools\",\"exec\",\"tools\"",
        ))
        .unwrap();
        assert_eq!(
            normalize_permissions(&manifest.permissions),
            vec!["exec", "tools"]
        );
        let text = payload(&manifest, &"ab".repeat(32));
        assert!(text.contains("\npermissions=exec,tools\n"), "{text}");
    }

    #[test]
    fn payload_is_pinned_byte_for_byte() {
        let manifest = parse_manifest(&manifest_json("com.example.demo", "\"tools\"")).unwrap();
        let text = payload(&manifest, &"0".repeat(64));
        let expected = concat!(
            "pi-extension-v1\n",
            "id=com.example.demo\n",
            "name=示例扩展\n",
            "version=1.2.0\n",
            "entry=index.mjs\n",
            "permissions=tools\n",
            "pi=>=1.5.0\n",
            "sha256=",
        );
        assert!(text.starts_with(expected), "{text}");
        assert!(text.ends_with('\n'));
        assert_eq!(text.lines().count(), 8);
    }

    #[test]
    fn verdicts_cover_every_signature_state() {
        let dir = tempfile::tempdir().unwrap();
        let extension = dir.path().join("demo");
        write_extension(
            &extension,
            &manifest_json("com.example.demo", "\"tools\",\"network\""),
        );
        let key = signing_key();

        assert_eq!(
            verify_extension(&extension, &BTreeMap::new()).verdict,
            Verdict::Unsigned
        );

        sign(&extension, &key, "release-2026");
        let outcome = verify_extension(&extension, &BTreeMap::new());
        assert_eq!(outcome.verdict, Verdict::UntrustedKey);
        assert!(outcome.signature.is_some());

        let store = trust_store_with(&key, "release-2026");
        let outcome = verify_extension(&extension, &store);
        assert_eq!(outcome.verdict, Verdict::Verified);
        assert!(outcome.error.is_empty());

        // 入口被改：签名失效
        fs::write(extension.join("index.mjs"), "export default () => 1;\n").unwrap();
        let outcome = verify_extension(&extension, &store);
        assert_eq!(outcome.verdict, Verdict::Invalid);
        assert!(outcome.error.contains("签名与载荷不匹配"));

        // 恢复入口并重新签名后篡改权限：签名同样失效
        fs::write(extension.join("index.mjs"), ENTRY_BODY).unwrap();
        sign(&extension, &key, "release-2026");
        assert_eq!(
            verify_extension(&extension, &store).verdict,
            Verdict::Verified
        );
        write_extension(
            &extension,
            &manifest_json("com.example.demo", "\"tools\",\"exec\""),
        );
        assert_eq!(
            verify_extension(&extension, &store).verdict,
            Verdict::Invalid
        );
    }

    #[test]
    fn broken_manifest_reports_a_reason() {
        let dir = tempfile::tempdir().unwrap();
        let extension = dir.path().join("bad");
        write_extension(
            &extension,
            r#"{"id":"com.example.demo","name":"x","version":"1.0.0","entry":"index.mjs","permissions":["root"]}"#,
        );
        let outcome = verify_extension(&extension, &BTreeMap::new());
        assert_eq!(outcome.verdict, Verdict::Broken);
        assert!(outcome.error.contains("未知权限"));
        assert!(outcome.signature.is_none());
        assert_eq!(verdict_label(outcome.verdict), "清单无效");
    }

    #[test]
    fn scan_lists_extensions_with_trust_store_and_stable_order() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let key = signing_key();
        write_extension(
            &root.join("beta"),
            &manifest_json("com.example.beta", "\"read\""),
        );
        write_extension(
            &root.join("alpha"),
            &manifest_json("com.example.alpha", "\"fs:any\""),
        );
        sign(&root.join("alpha"), &key, "release-2026");
        fs::write(
            root.join(TRUST_STORE),
            serde_json::to_vec(&trust_store_with(&key, "release-2026")).unwrap(),
        )
        .unwrap();
        fs::create_dir_all(root.join("stray")).unwrap();

        let result = scan(root);
        assert_eq!(result["trustedKeys"].as_array().unwrap().len(), 1);
        let items = result["extensions"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["id"], "com.example.alpha");
        assert_eq!(items[0]["verdict"], "verified");
        assert_eq!(items[1]["id"], "com.example.beta");
        assert_eq!(items[1]["verdict"], "unsigned");
        assert_eq!(items[2]["verdict"], "broken");
        assert!(items[2]["error"]
            .as_str()
            .unwrap()
            .contains("manifest.json"));
    }

    #[test]
    fn malformed_trust_store_does_not_block_listing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(TRUST_STORE), b"not json").unwrap();
        write_extension(&root.join("demo"), &manifest_json("com.example.demo", "[]"));
        assert!(load_trust_store(root).is_empty());
        let result = scan(root);
        assert_eq!(result["extensions"].as_array().unwrap().len(), 1);
    }

    /// 跨语言夹具：签名由 scripts/sign-extension.mjs（Node）生成。
    /// Rust 必须对完全相同的载荷验证通过，否则两侧规则已经分叉。
    #[test]
    fn node_generated_signature_verifies() {
        const MANIFEST: &str = r#"{"id":"com.example.node-signed","name":"跨语言夹具","version":"1.2.3","entry":"index.mjs","permissions":["network","tools"],"pi":">=1.5.0"}"#;
        const ENTRY: &str = "export default () => 'fixture';";
        const ENTRY_SHA: &str = "f3bb8f440a07d45c277f6ae42d6109bc4d62217fb938ecdd0566128152f22c32";
        const PUBLIC_KEY: &str = "lKTaQQrD2fWIDBIawiX4I63H044xesaEprzRkPQoSI0=";
        const SIGNATURE: &str = "hkAKrbwYBLwVPRgSgkHl+jS7SWVPspjdKcr0innSYJSBJ2jz0LwIjpzFLfE9GvmSbbQWb97k0E9rxIoKoZ+yCQ==";

        let dir = tempfile::tempdir().unwrap();
        let extension = dir.path().join("demo");
        write_extension(&extension, MANIFEST);
        fs::write(extension.join("index.mjs"), ENTRY).unwrap();
        assert_eq!(entry_sha256(&extension, "index.mjs").unwrap(), ENTRY_SHA);

        let manifest = parse_manifest(MANIFEST).unwrap();
        let text = payload(&manifest, ENTRY_SHA);
        let expected = [
            "pi-extension-v1".to_owned(),
            "id=com.example.node-signed".to_owned(),
            "name=跨语言夹具".to_owned(),
            "version=1.2.3".to_owned(),
            "entry=index.mjs".to_owned(),
            "permissions=network,tools".to_owned(),
            "pi=>=1.5.0".to_owned(),
            format!("sha256={ENTRY_SHA}"),
            String::new(),
        ]
        .join("\n");
        assert_eq!(text, expected);

        fs::write(
            extension.join("signature.json"),
            serde_json::to_vec(&serde_json::json!({
                "algorithm": "ed25519",
                "keyId": "node-fixture",
                "signature": SIGNATURE,
            }))
            .unwrap(),
        )
        .unwrap();

        let mut store = BTreeMap::new();
        store.insert("node-fixture".to_owned(), PUBLIC_KEY.to_owned());
        let outcome = verify_extension(&extension, &store);
        assert_eq!(outcome.verdict, Verdict::Verified, "{}", outcome.error);

        // 同一个签名换到被改动的入口上必须失败。
        fs::write(
            extension.join("index.mjs"),
            "export default () => 'tampered';",
        )
        .unwrap();
        assert_eq!(
            verify_extension(&extension, &store).verdict,
            Verdict::Invalid
        );
    }
}
