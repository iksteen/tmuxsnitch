//! Session-owner recordings client: manage YOUR OWN recordings on a hub
//! (`shellglass recordings …`, or the `shellglass-recordings` binary).
//!
//! A thin HTTP client over the hub's owner routes (`/recordings`,
//! `/recordings/<name>`), authenticated with the SESSION key — the same
//! secret `push` uses, sent in the same `x-shellglass-key` header. The key
//! names the session, so only that session's recordings are ever reachable;
//! there is no id or slug to pass (or get wrong). The management-side
//! equivalent (any session, Bearer credential) is `shellglass sessions
//! recordings` ([`crate::apictl`]); the mechanics both share live in
//! [`crate::cliutil`].

use crate::cliutil::{body_capped, checked_name, client, print_recordings, save_stream};
use anyhow::{Context, Result, bail};
use reqwest::StatusCode;
use std::path::Path;

fn base(hub: &str) -> String {
    format!("{}/recordings", hub.trim_end_matches('/'))
}

/// Pass a successful response through for the caller to consume; turn a
/// failure status into a readable error — the hub's own `{"error": …}`
/// message when present (neutered: the hub is untrusted), else the status.
async fn check(res: reqwest::Response) -> Result<reqwest::Response> {
    let status = res.status();
    if status.is_success() {
        return Ok(res);
    }
    let body = body_capped(res).await.unwrap_or_default();
    let msg = crate::proto::neuter(
        &serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
            .unwrap_or(body),
    );
    match status {
        StatusCode::UNAUTHORIZED => bail!("{status}: missing/unusable session key"),
        StatusCode::FORBIDDEN => {
            bail!("{status}: key not authorized — is its session id on the hub's --allow?")
        }
        _ if msg.is_empty() => bail!("{status}"),
        _ => bail!("{status}: {msg}"),
    }
}

/// `GET /recordings` — print the session's recordings, oldest first.
pub async fn list(hub: &str, key: &str) -> Result<()> {
    let res = client()?
        .get(base(hub))
        .header(crate::proto::KEY_HEADER, key)
        .send()
        .await
        .context("requesting the recording list")?;
    print_recordings(&body_capped(check(res).await?).await?)
}

/// `GET /recordings/<name>` — download one recording, streamed (a stream can
/// be tens of MB — the register carries the font bundle). See
/// [`crate::cliutil::save_stream`] for the output semantics.
pub async fn get(hub: &str, key: &str, name: &str, output: Option<&Path>) -> Result<()> {
    let name = checked_name(name)?;
    let res = client()?
        .get(format!("{}/{name}", base(hub)))
        .header(crate::proto::KEY_HEADER, key)
        .send()
        .await
        .context("requesting the recording")?;
    save_stream(check(res).await?, name, output).await
}

/// `DELETE /recordings/<name>` — delete one recording.
pub async fn delete(hub: &str, key: &str, name: &str) -> Result<()> {
    let name = checked_name(name)?;
    let res = client()?
        .delete(format!("{}/{name}", base(hub)))
        .header(crate::proto::KEY_HEADER, key)
        .send()
        .await
        .context("deleting the recording")?;
    check(res).await?;
    println!("deleted {name}");
    Ok(())
}
