//! Only compiled into test-fixture builds (or unit tests), never production builds.
use anyhow::{ensure, Result};

pub fn browser_arguments(value: Option<&str>) -> Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    ensure!(
        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()),
        "PI_DESKTOP_DEBUG_PORT must be a numeric TCP port"
    );
    let port: u16 = value.parse()?;
    ensure!(port != 0, "PI_DESKTOP_DEBUG_PORT must be nonzero");
    Ok(Some(format!(
        "--remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_port_is_optional_and_accepts_dynamic_ports() {
        assert_eq!(browser_arguments(None).unwrap(), None);
        for port in ["1", "9224", "56027", "65535"] {
            assert_eq!(
                browser_arguments(Some(port)).unwrap(),
                Some(format!(
                    "--remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
                ))
            );
        }
    }

    #[test]
    fn debug_port_rejects_invalid_values_and_argument_injection() {
        for value in [
            "",
            "0",
            "65536",
            "-1",
            "+9224",
            " 9224",
            "9224 --no-sandbox",
        ] {
            assert!(browser_arguments(Some(value)).is_err(), "{value}");
        }
    }
}
