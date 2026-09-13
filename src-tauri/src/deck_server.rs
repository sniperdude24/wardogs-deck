use crate::state::DeckState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

pub const DEFAULT_PORT: u16 = 8931;

/// How long a command waits for the webview to publish a fresh snapshot
/// before answering with whatever is cached.
const COMMAND_SETTLE: Duration = Duration::from_millis(250);

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
    state: Arc<DeckState>,
}

/// Local HTTP API for the Stream Deck plugin. Bound to 127.0.0.1 only.
pub async fn spawn(app: AppHandle, state: Arc<DeckState>, port: u16) {
    let listener = loop {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => break listener,
            Err(error) => {
                eprintln!("deck api: port {port} busy ({error}); retrying in 3s");
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
    };

    let router = Router::new()
        .route("/api/ping", get(api_ping))
        .route("/api/state", get(api_state))
        .route("/api/cmd", post(api_cmd))
        .route("/api/focus", post(api_focus))
        .with_state(Ctx { app, state });

    if let Err(error) = axum::serve(listener, router).await {
        eprintln!("deck api error: {error}");
    }
}

async fn api_ping() -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "app": "wardogs-deck",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn snapshot(ctx: &Ctx) -> Response {
    match ctx.state.latest.lock().await.clone() {
        Some(state) => Json(json!({ "ok": true, "state": state })).into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": "calculator not ready yet" })),
        )
            .into_response(),
    }
}

async fn api_state(State(ctx): State<Ctx>) -> Response {
    snapshot(&ctx).await
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

async fn api_focus(State(ctx): State<Ctx>) -> Response {
    show_main(&ctx.app);
    Json(json!({ "ok": true })).into_response()
}

/// Body: `{ "cmd": "...", ...args }`. Most commands are relayed to the
/// webview as a `deck-cmd` event and answered with the snapshot it
/// publishes in response. `copy` and `focus` are handled here because
/// the clipboard and window focus do not need the page.
async fn api_cmd(State(ctx): State<Ctx>, Json(body): Json<serde_json::Value>) -> Response {
    let cmd = body
        .get("cmd")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();

    match cmd.as_str() {
        "" => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "missing cmd" })),
        )
            .into_response(),

        "focus" => api_focus(State(ctx)).await,

        "copy" => {
            let text = ctx
                .state
                .latest
                .lock()
                .await
                .as_ref()
                .and_then(|state| state.get("copyText"))
                .and_then(|value| value.as_str())
                .map(str::to_string);

            match text {
                Some(text) => match ctx.app.clipboard().write_text(text.clone()) {
                    Ok(()) => Json(json!({ "ok": true, "copied": text })).into_response(),
                    Err(error) => (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "ok": false, "error": error.to_string() })),
                    )
                        .into_response(),
                },
                None => (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({ "ok": false, "error": "nothing to copy yet" })),
                )
                    .into_response(),
            }
        }

        _ => {
            let since = ctx.state.current_generation();

            if let Err(error) = ctx.app.emit("deck-cmd", body) {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "ok": false, "error": error.to_string() })),
                )
                    .into_response();
            }

            ctx.state.wait_for_newer(since, COMMAND_SETTLE).await;
            snapshot(&ctx).await
        }
    }
}
