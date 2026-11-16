// Desk Pet for Grok Bot (unofficial, working title).
// The Rust side is intentionally tiny: a transparent always-on-top window plus the opener
// plugin. All relay/SSE logic lives in the web frontend.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // A desk pet should not take a Dock slot or the app switcher on macOS.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Desk Pet");
}
