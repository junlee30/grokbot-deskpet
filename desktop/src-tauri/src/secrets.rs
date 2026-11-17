//! Secrets in the OS keychain (macOS Keychain via the `keyring` crate), service
//! "com.grokbot.deskpet":
//!
//!   account "relay-token:<relay host[:port]>"  v1 relay token (deprecated, self-hosted relays
//!                                              only). A token belongs to exactly one relay, so
//!                                              changing the relay means pairing again.
//!   account "mailbox-v2"                       v2 pairing string (topic + key + mailbox URL).
//!
//! Nothing in here logs secrets. The v1 token never reaches the webview; the v2 pairing string
//! only does when the user asks to see/copy the paste line.

use keyring::Entry;

pub const SERVICE: &str = "com.grokbot.deskpet";

/// Keychain account for a (normalised) relay URL, e.g. `relay-token:127.0.0.1:8787`.
pub fn account_for(relay: &url::Url) -> String {
    let host = relay.host_str().unwrap_or("unknown");
    match relay.port() {
        Some(p) => format!("relay-token:{host}:{p}"),
        None => format!("relay-token:{host}"),
    }
}

/// Bearer tokens issued by the relay: 32 random bytes, base64url.
pub fn looks_like_token(t: &str) -> bool {
    (16..=256).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn entry(relay: &url::Url) -> Result<Entry, String> {
    Entry::new(SERVICE, &account_for(relay)).map_err(|e| format!("keychain unavailable: {}", kind(&e)))
}

/// Error description that can never contain secret material.
fn kind(e: &keyring::Error) -> &'static str {
    match e {
        keyring::Error::NoEntry => "no entry",
        keyring::Error::NoStorageAccess(_) => "access denied",
        keyring::Error::PlatformFailure(_) => "platform failure",
        keyring::Error::BadEncoding(_) => "bad encoding",
        keyring::Error::TooLong(_, _) => "too long",
        keyring::Error::Invalid(_, _) => "invalid",
        keyring::Error::Ambiguous(_) => "ambiguous",
        _ => "error",
    }
}

pub fn get(relay: &url::Url) -> Result<Option<String>, String> {
    match entry(relay)?.get_password() {
        Ok(t) if looks_like_token(&t) => Ok(Some(t)),
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain read failed: {}", kind(&e))),
    }
}

pub fn set(relay: &url::Url, token: &str) -> Result<(), String> {
    if !looks_like_token(token) {
        return Err("refusing to store a malformed token".into());
    }
    entry(relay)?
        .set_password(token)
        .map_err(|e| format!("keychain write failed: {}", kind(&e)))
}

pub fn delete(relay: &url::Url) -> Result<(), String> {
    match entry(relay)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {}", kind(&e))),
    }
}

// ---------------------------------------------------------------- retired v1 relays

/// Hosts of v1 relays that no longer exist. The hosted relay was shut down on 2026-11-16 when
/// v1 was deprecated; a token for it can never work again, so the app forgets it on startup
/// instead of retrying forever, and refuses the URL (see `relay::normalize_relay_url`).
pub const RETIRED_RELAY_HOSTS: &[&str] = &["grokbot-deskpet-relay.fly.dev"];

pub fn is_retired_relay_host(host: &str) -> bool {
    RETIRED_RELAY_HOSTS.iter().any(|h| host.eq_ignore_ascii_case(h))
}

/// Keychain accounts that held tokens for the retired relays.
pub fn retired_accounts() -> Vec<String> {
    RETIRED_RELAY_HOSTS.iter().map(|h| format!("relay-token:{h}")).collect()
}

/// Delete v1 tokens for retired relays. Returns how many entries were removed. Only touches the
/// `relay-token:<retired host>` accounts, never the v2 pairing (`mailbox-v2`).
pub fn purge_retired_relay_tokens() -> usize {
    let mut removed = 0;
    for account in retired_accounts() {
        if let Ok(e) = Entry::new(SERVICE, &account) {
            if e.delete_credential().is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

// ---------------------------------------------------------------- v2 pairing

pub const V2_ACCOUNT: &str = "mailbox-v2";

fn v2_entry() -> Result<Entry, String> {
    Entry::new(SERVICE, V2_ACCOUNT).map_err(|e| format!("keychain unavailable: {}", kind(&e)))
}

/// The stored v2 pairing, if any (an unparsable entry counts as none).
pub fn v2_get() -> Result<Option<crate::v2::Pairing>, String> {
    match v2_entry()?.get_password() {
        Ok(s) => Ok(crate::v2::Pairing::decode(&s).ok()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain read failed: {}", kind(&e))),
    }
}

pub fn v2_set(p: &crate::v2::Pairing) -> Result<(), String> {
    v2_entry()?
        .set_password(&p.encode())
        .map_err(|e| format!("keychain write failed: {}", kind(&e)))
}

pub fn v2_delete() -> Result<(), String> {
    match v2_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {}", kind(&e))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_names_include_non_default_ports() {
        let local = url::Url::parse("http://127.0.0.1:8787").unwrap();
        let own = url::Url::parse("https://relay.example.com").unwrap();
        assert_eq!(account_for(&local), "relay-token:127.0.0.1:8787");
        assert_eq!(account_for(&own), "relay-token:relay.example.com");
    }

    #[test]
    fn retired_relay_cleanup_targets_only_v1_tokens() {
        assert!(is_retired_relay_host("grokbot-deskpet-relay.fly.dev"));
        assert!(is_retired_relay_host("GROKBOT-DESKPET-RELAY.FLY.DEV"));
        assert!(!is_retired_relay_host("relay.example.com"));
        assert!(!is_retired_relay_host("127.0.0.1"));
        let accounts = retired_accounts();
        assert!(!accounts.is_empty());
        for a in &accounts {
            assert!(a.starts_with("relay-token:"), "{a}");
            assert_ne!(a, V2_ACCOUNT, "the v2 pairing is never purged");
            // Same account name the app used when it stored the token.
            let host = a.trim_start_matches("relay-token:");
            assert_eq!(&account_for(&url::Url::parse(&format!("https://{host}")).unwrap()), a);
        }
    }

    #[test]
    fn token_shape() {
        assert!(looks_like_token("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"));
        assert!(!looks_like_token("short"));
        assert!(!looks_like_token("has space in it padding padding"));
        assert!(!looks_like_token("Bearer\nInjected-Header-Value-xx"));
    }
}
