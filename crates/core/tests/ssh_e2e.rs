//! SSH key helpers against the managed `Vibecoder` distro. Gated: VIBECODE_E2E=1 (use
//! `WSLENV=VIBECODE_E2E` when launching from WSL). Does not register the key anywhere.

use std::sync::Arc;

use vibecode_core::backend::wsl::{list_distros, WslBackend};
use vibecode_core::backend::ExecBackend;
use vibecode_core::git::ssh;

#[tokio::test]
#[ignore]
async fn key_info_and_generate_on_vibecoder() {
    if std::env::var("VIBECODE_E2E").ok().as_deref() != Some("1") {
        eprintln!("skipping: VIBECODE_E2E not set");
        return;
    }
    if !list_distros().await.iter().any(|d| d == "Vibecoder") {
        eprintln!("skipping: Vibecoder distro missing");
        return;
    }
    let backend: Arc<dyn ExecBackend> = Arc::new(WslBackend::new("Vibecoder".into()));
    let before = ssh::key_info(backend.clone()).await.expect("key_info");
    eprintln!("before: present={} known={}", before.present, before.github_known_host);
    let after = ssh::generate_key(backend.clone()).await.expect("generate_key");
    assert!(after.present);
    assert!(after.public_key.as_deref().unwrap_or("").starts_with("ssh-"));
    assert!(after.path.as_deref().unwrap_or("").ends_with("id_ed25519") || after.path.as_deref().unwrap_or("").ends_with("id_rsa"));
    eprintln!("public key: {}", after.public_key.clone().unwrap_or_default());
    let again = ssh::generate_key(backend.clone()).await.expect("idempotent");
    assert_eq!(again.public_key, after.public_key);
    match ssh::test_github(backend).await {
        Ok(user) => eprintln!("github user: {user}"),
        Err(e) => eprintln!("github test (expected to fail for an unregistered key): {e}"),
    }
}
