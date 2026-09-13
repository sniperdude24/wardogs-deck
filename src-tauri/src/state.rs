use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

/// The webview is the single source of truth for the firing solution. It
/// publishes a JSON snapshot after every change; this just caches the
/// latest one for the HTTP API and lets a waiting request notice a newer
/// generation arriving.
pub struct DeckState {
    pub latest: Mutex<Option<serde_json::Value>>,
    pub generation: AtomicU64,
}

impl DeckState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            latest: Mutex::new(None),
            generation: AtomicU64::new(0),
        })
    }

    pub async fn publish(&self, payload: serde_json::Value) {
        *self.latest.lock().await = Some(payload);
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Wait (bounded) until a publish newer than `since` lands.
    pub async fn wait_for_newer(&self, since: u64, timeout: std::time::Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if self.current_generation() > since {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(8)).await;
        }
    }
}
