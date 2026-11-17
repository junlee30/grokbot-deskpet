//! Secrets in the OS keychain (macOS Keychain via the `keyring` crate), service
//! "com.grokbot.deskpet":
//!
//!   account "relay-token:<relay host[:port]>"  v1 relay token. A token belongs to exactly one
//!                                              relay, so changing the relay means pairing again.
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
        let hosted = url::Url::parse("https://grokbot-deskpet-relay.fly.dev").unwrap();
        assert_eq!(account_for(&local), "relay-token:127.0.0.1:8787");
        assert_eq!(account_for(&hosted), "relay-token:grokbot-deskpet-relay.fly.dev");
    }

    #[test]
    fn token_shape() {
        assert!(looks_like_token("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"));
        assert!(!looks_like_token("short"));
        assert!(!looks_like_token("has space in it padding padding"));
        assert!(!looks_like_token("Bearer\nInjected-Header-Value-xx"));
    }
}
