mod commands;
mod deck_server;
mod state;

use state::DeckState;
use tauri::Manager;

fn api_port() -> u16 {
    std::env::var("WARDOGS_DECK_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(deck_server::DEFAULT_PORT)
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch (e.g. from the Stream Deck "App" key) just
            // brings the existing window forward.
            show_main(app);
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Closing the window hides to the tray so the deck keeps
            // working mid-match; the tray menu is the real quit.
            let show_item =
                tauri::menu::MenuItem::with_id(app, "show", "Show WARDOGS Deck", true, None::<&str>)?;
            let quit_item =
                tauri::menu::MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = tauri::menu::Menu::with_items(app, &[&show_item, &quit_item])?;

            tauri::tray::TrayIconBuilder::with_id("wardogs-deck-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("WARDOGS Deck")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            let state = DeckState::new();
            app.manage(state.clone());

            let port = api_port();
            tauri::async_runtime::spawn(async move {
                deck_server::spawn(handle, state, port).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![commands::publish_state])
        .run(tauri::generate_context!())
        .expect("error while running WARDOGS Deck");
}
