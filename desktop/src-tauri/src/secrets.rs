//! Secrets in the OS keychain (macOS Keychain via the `keyring` crate), service
//! "com.grokbot.deskpet":
//!
//!   account "mailbox-v2"   the v2 pairing string (topic + key + mailbox URL).
//!
//! The pairing string reaches the webview only when the user asks to see/copy the paste line.
//! Nothing in here logs secrets.

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
