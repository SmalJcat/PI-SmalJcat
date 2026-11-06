use serde_json::{json, Value};

pub fn valid_server(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
pub fn parse_status(text: &str) -> Value {
    let mut servers: Vec<Value> = Vec::new();
    let mut diagnostics = Vec::new();
    for line in text.lines() {
        if line.starts_with("    ") {
            if let Some(server) = servers.last_mut() {
                let previous = server["error"].as_str().unwrap_or_default();
                server["error"] = format!(
                    "{}{}{}",
                    previous,
                    if previous.is_empty() { "" } else { "\n" },
                    line.trim()
                )
                .into();
            }
            continue;
        }
        let Some((name, description)) = line.split_once(": ") else {
            if !line.trim().is_empty() {
                diagnostics.push(line.to_owned());
            }
            continue;
        };
        if !valid_server(name) {
            diagnostics.push(line.to_owned());
            continue;
        }
        let (details, exposure) = description
            .rsplit_once(" (")
            .map(|(a, b)| (a, b.trim_end_matches(')')))
            .unwrap_or((description, "unknown"));
        let state = if details.starts_with("needs sign-in") {
            "needs-auth"
        } else {
            details.split(',').next().unwrap_or("unknown")
        };
        if ![
            "connected",
            "disabled",
            "disconnected",
            "starting",
            "connecting",
            "failed",
            "needs-auth",
            "closed",
        ]
        .contains(&state)
        {
            diagnostics.push(line.to_owned());
            continue;
        }
        let count = details
            .split(", ")
            .find_map(|v| v.strip_suffix(" tools").and_then(|v| v.parse::<u64>().ok()));
        servers
            .push(json!({"name":name,"state":state,"tools":count,"exposure":exposure,"error":""}));
    }
    json!({"servers":servers,"diagnostics":diagnostics,"raw":text,"checkedAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_status_and_errors_without_guessing() {
        let result=parse_status("good: connected, 12 tools (deferred)\nbad: failed (direct)\n    connection refused\n    detail\nlogin: needs sign-in, run /mcp login login (codemode)\nconfig error: invalid server");
        assert_eq!(result["servers"][0]["tools"], 12);
        assert_eq!(result["servers"][1]["error"], "connection refused\ndetail");
        assert_eq!(result["servers"][2]["state"], "needs-auth");
        assert_eq!(result["diagnostics"].as_array().unwrap().len(), 1);
        assert!(!valid_server("a /reload"));
    }
}
