//! Clicking a pet opens the Grok Bot desktop app on that bot's chat:
//! `grokbot://app/v1/agent?id=<uuid>` (or `grokbot://` to just bring Grok Bot to the front when
//! the bot hasn't sent its id). The webview opens the URL through the opener plugin; the
//! `pets` capability allows exactly these two URL shapes and nothing else.
//!
//! macOS `open` doesn't report a missing URL handler back to the opener plugin, so the webview
//! asks `grokbot_installed` first and does nothing when no app claims `grokbot:`.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

use crate::log_line;

/// Bring Grok Bot to the front (no particular chat).
pub const APP_URL: &str = "grokbot://";
/// Grok Bot's deep link to one agent's chat; the id goes right after it.
pub const CHAT_URL_PREFIX: &str = "grokbot://app/v1/agent?id=";

/// The URL a click on a pet opens, built only from a validated id (see `v2::grokbot_id_ok`).
/// The webview builds the same URL (src/petwin.ts `grokbotUrl`); this is the reference and
/// what the capability test checks.
#[cfg_attr(not(test), allow(dead_code))]
pub fn chat_url(grokbot_id: Option<&str>) -> String {
    match grokbot_id.filter(|id| crate::v2::grokbot_id_ok(id)) {
        Some(id) => format!("{CHAT_URL_PREFIX}{id}"),
        None => APP_URL.to_string(),
    }
}

/// Whether some app (Grok Bot) handles `grokbot:` URLs, per LaunchServices.
#[cfg(target_os = "macos")]
fn handler_installed() -> bool {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    let Some(url) = NSURL::URLWithString(&NSString::from_str(APP_URL)) else { return false };
    NSWorkspace::sharedWorkspace().URLForApplicationToOpenURL(&url).is_some()
}

#[cfg(not(target_os = "macos"))]
fn handler_installed() -> bool {
    true // let the OS decide; nothing to check cheaply
}

static LOGGED_MISSING: AtomicBool = AtomicBool::new(false);

/// True if Grok Bot is installed. When it isn't, a click does nothing; that is logged once.
#[tauri::command]
pub fn grokbot_installed(app: AppHandle) -> bool {
    let ok = handler_installed();
    if !ok && !LOGGED_MISSING.swap(true, Ordering::Relaxed) {
        log_line(&app, "pet click: Grok Bot isn't installed (no app handles grokbot: links); clicks do nothing");
    }
    ok
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const ID: &str = "2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f";

    #[test]
    fn chat_url_only_from_a_valid_id() {
        assert_eq!(chat_url(Some(ID)), format!("grokbot://app/v1/agent?id={ID}"));
        assert_eq!(chat_url(None), "grokbot://");
        for bad in ["", "jarvis", "2F06D68C-1B2A-4C3D-8E9F-0A1B2C3D4E5F", "x&y=1", "../../etc", "2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f#x"] {
            assert_eq!(chat_url(Some(bad)), "grokbot://", "{bad:?}");
        }
    }

    /// The opener plugin matches URLs with `glob::Pattern` against `capabilities/pets.json`.
    /// Pet windows may open exactly `grokbot://` and `grokbot://app/v1/agent?id=<uuid>`.
    #[test]
    fn pets_capability_allows_only_grokbot_links() {
        let cap: Value = serde_json::from_str(include_str!("../capabilities/pets.json")).unwrap();
        let perms = cap["permissions"].as_array().unwrap();
        let opener: Vec<&Value> = perms.iter().filter(|p| p.to_string().contains("opener")).collect();
        assert_eq!(opener.len(), 1, "one opener permission");
        assert_eq!(opener[0]["identifier"], "opener:allow-open-url");
        let pats: Vec<glob::Pattern> = opener[0]["allow"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                assert_eq!(e.as_object().unwrap().len(), 1, "url only, no `app`");
                glob::Pattern::new(e["url"].as_str().unwrap()).unwrap()
            })
            .collect();
        let allowed = |u: &str| pats.iter().any(|p| p.matches(u));

        assert!(allowed(&chat_url(Some(ID))));
        assert!(allowed(&chat_url(None)));
        assert!(allowed(&chat_url(Some("00000000-0000-0000-0000-000000000000"))));
        for bad in [
            "https://grok.com",
            "http://example.com",
            "file:///etc/passwd",
            "sand://app/v1/agent?id=2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f",
            "grokbot:",
            "grokbot:///",
            "grokbot://app",
            "grokbot://app/v1/agent",
            "grokbot://app/v1/agent?id=",
            "grokbot://app/v1/agentXid=2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f",
            "grokbot://app/v1/agent?id=2F06D68C-1B2A-4C3D-8E9F-0A1B2C3D4E5F",
            "grokbot://app/v1/agent?id=2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f&x=1",
            "grokbot://app/v1/agent?id=2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f/",
            "grokbot://app/v1/agent?id=2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5",
            "grokbot://app/v1/agent?id=2f06d68c1b2a-4c3d-8e9f-0a1b2c3d4e5f0",
            "grokbot://app/v1/agent?id=../../../x-1b2a-4c3d-8e9f-0a1b2c3d4e5f",
            "grokbot://app/v1/settings?id=2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f",
            "grokbot://evil/v1/agent?id=2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f",
            "GROKBOT://app/v1/agent?id=2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f",
        ] {
            assert!(!allowed(bad), "{bad}");
        }
    }
}
