pub mod agent_history;
pub mod agents;
pub mod context;
pub mod core;
#[cfg(feature = "desktop")]
pub mod desktop;
pub mod mcp;
pub mod review;
pub mod rpc;
pub mod session_guard;
pub mod workspace;

#[cfg(any(test, all(feature = "test-fixture", feature = "desktop")))]
mod test_support;
