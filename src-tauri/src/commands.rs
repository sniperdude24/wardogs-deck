use crate::state::DeckState;
use std::sync::Arc;
use tauri::State;

/// Called by js/bridge/deck-bridge.js after every calculator change.
#[tauri::command]
pub async fn publish_state(
    state: State<'_, Arc<DeckState>>,
    payload: serde_json::Value,
) -> Result<(), String> {
    state.publish(payload).await;
    Ok(())
}
