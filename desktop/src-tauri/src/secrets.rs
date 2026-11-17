//! Secrets in the OS keychain (macOS Keychain via the `keyring` crate), service
//! "com.grokbot.deskpet":
//!
//!   account "mailbox-v2"   the v2 pairing string (topic + key + mailbox URL).
//!
//! The pairing string reaches the webview only when the user asks to see/copy the paste line.
//! Nothing in here logs secrets.
//!
//! Older versions also stored v1 relay tokens as "relay-token:<host[:port]>". v1 is gone from
//! the app; `purge_v1_relay_tokens` deletes any that are left (once, at startup; see main.rs).

use keyring::Entry;

pub const SERVICE: &str = "com.grokbot.deskpet";

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

// ---------------------------------------------------------------- v1 leftovers

/// Prefix of the Keychain accounts that held v1 relay tokens.
pub const V1_ACCOUNT_PREFIX: &str = "relay-token:";

/// v1 accounts an older build is known to have used, for when the Keychain can't be listed.
const KNOWN_V1_ACCOUNTS: &[&str] = &["relay-token:grokbot-deskpet-relay.fly.dev", "relay-token:127.0.0.1:8787", "relay-token:localhost:8787"];

/// Is this one of our accounts a leftover v1 relay token? Never true for the v2 pairing.
pub fn is_v1_account(account: &str) -> bool {
    account.starts_with(V1_ACCOUNT_PREFIX) && account != V2_ACCOUNT
}

/// Account names (attributes only, never the stored data) of our Keychain items.
#[cfg(target_os = "macos")]
fn list_accounts() -> Result<Vec<String>, String> {
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
    let found = ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(SERVICE)
        .load_attributes(true)
        .load_data(false)
        .limit(Limit::All)
        .search();
    match found {
        Ok(items) => Ok(items.iter().filter_map(|i| i.simplify_dict()?.get("acct").cloned()).collect()),
        // errSecItemNotFound: nothing stored under our service at all.
        Err(e) if e.code() == -25300 => Ok(Vec::new()),
        Err(e) => Err(format!("keychain search failed ({})", e.code())),
    }
}

#[cfg(not(target_os = "macos"))]
fn list_accounts() -> Result<Vec<String>, String> {
    Ok(KNOWN_V1_ACCOUNTS.iter().map(|s| s.to_string()).collect())
}

/// Delete every leftover v1 relay token. Returns how many were removed. Only ever deletes
/// `relay-token:*` accounts; the v2 pairing (`mailbox-v2`) is never read, written or deleted.
pub fn purge_v1_relay_tokens() -> Result<usize, String> {
    let mut accounts: Vec<String> = list_accounts()?.into_iter().filter(|a| is_v1_account(a)).collect();
    for k in KNOWN_V1_ACCOUNTS {
        if !accounts.iter().any(|a| a == k) {
            accounts.push(k.to_string());
        }
    }
    let mut removed = 0;
    let mut failed = false;
    for account in accounts.iter().filter(|a| is_v1_account(a)) {
        let Ok(entry) = Entry::new(SERVICE, account) else { continue };
        match entry.delete_credential() {
            Ok(()) => removed += 1,
            Err(keyring::Error::NoEntry) => {}
            Err(_) => failed = true,
        }
    }
    if failed {
        return Err("some v1 tokens could not be deleted".into());
    }
    Ok(removed)
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
    fn v1_cleanup_never_targets_the_v2_pairing() {
        assert!(is_v1_account("relay-token:grokbot-deskpet-relay.fly.dev"));
        assert!(is_v1_account("relay-token:127.0.0.1:8787"));
        assert!(is_v1_account("relay-token:relay.example.com"));
        assert!(!is_v1_account(V2_ACCOUNT));
        assert!(!is_v1_account("mailbox-v2-backup"));
        assert!(!is_v1_account("RELAY-TOKEN:x"), "exact prefix only");
        assert!(!is_v1_account(""));
        for k in KNOWN_V1_ACCOUNTS {
            assert!(is_v1_account(k), "{k}");
        }
    }
}
