//! Hub-control client: drive the hub's session-management API from the CLI
//! (`shellglass sessions …`, or the `shellglass-sessions` binary).
//!
//! A thin HTTP client over the `/api/sessions` routes with the same explicit
//! delete semantics as the API itself: `remove --id` and `remove --slug` name
//! the namespace — there is no guessing form, because an un-aliased slug IS
//! the session id. Authenticates with `Authorization: Bearer <key>` in the
//! API salt domain (the key's `api_id` must be on the hub's `--api-allow`).

use anyhow::{Context, Result, bail};
use reqwest::StatusCode;

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .build()
        .context("building HTTP client")
}

fn base(hub: &str) -> String {
    format!("{}/api/sessions", hub.trim_end_matches('/'))
}

/// Turn a non-success response into a readable error: the API's own
/// `{"error": …}` message when present, the raw body otherwise.
async fn check(res: reqwest::Response) -> Result<reqwest::Response> {
    let status = res.status();
    if status.is_success() {
        return Ok(res);
    }
    let body = res.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
        .unwrap_or(body);
    match status {
        StatusCode::NOT_FOUND if msg.is_empty() => {
            bail!("{status}: not found — is the hub's management API enabled (--api-allow)?")
        }
        StatusCode::UNAUTHORIZED => bail!("{status}: missing/unusable API key"),
        StatusCode::FORBIDDEN => {
            bail!("{status}: key not authorized — is its API id on the hub's --api-allow?")
        }
        _ if msg.is_empty() => bail!("{status}"),
        _ => bail!("{status}: {msg}"),
    }
}

/// `GET /api/sessions` — print every registered session.
pub async fn list(hub: &str, key: &str) -> Result<()> {
    let res = client()?
        .get(base(hub))
        .bearer_auth(key)
        .send()
        .await
        .context("requesting the session list")?;
    let body = check(res).await?.text().await?;
    let sessions: Vec<serde_json::Value> =
        serde_json::from_str(&body).context("parsing the session list")?;
    if sessions.is_empty() {
        println!("no sessions registered");
        return Ok(());
    }
    println!("{:<24} {:<8} SESSION ID", "SLUG", "STATE");
    for s in sessions {
        println!(
            "{:<24} {:<8} {}",
            s["slug"].as_str().unwrap_or("?"),
            if s["live"].as_bool().unwrap_or(false) {
                "live"
            } else {
                "offline"
            },
            s["id"].as_str().unwrap_or("?"),
        );
    }
    Ok(())
}

/// `POST /api/sessions` — register a session by its public id.
pub async fn add(hub: &str, key: &str, id: &str, slug: Option<&str>) -> Result<()> {
    let mut body = serde_json::json!({ "id": id });
    if let Some(slug) = slug {
        body["slug"] = slug.into();
    }
    let res = client()?
        .post(base(hub))
        .bearer_auth(key)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .context("adding the session")?;
    let created: serde_json::Value = serde_json::from_str(&check(res).await?.text().await?)
        .context("parsing the add response")?;
    println!(
        "added {} — view at {}/s/{}",
        created["id"].as_str().unwrap_or(id),
        hub.trim_end_matches('/'),
        created["slug"].as_str().unwrap_or(id),
    );
    Ok(())
}

/// `DELETE /api/sessions/by-id/{id}` — remove BY SESSION ID.
pub async fn remove_by_id(hub: &str, key: &str, id: &str) -> Result<()> {
    let res = client()?
        .delete(format!("{}/by-id/{id}", base(hub)))
        .bearer_auth(key)
        .send()
        .await
        .context("removing the session")?;
    check(res).await?;
    println!("removed session {id}");
    Ok(())
}

/// `DELETE /api/sessions/by-slug/{slug}` — remove BY VIEW SLUG.
pub async fn remove_by_slug(hub: &str, key: &str, slug: &str) -> Result<()> {
    let res = client()?
        .delete(format!("{}/by-slug/{slug}", base(hub)))
        .bearer_auth(key)
        .send()
        .await
        .context("removing the session")?;
    check(res).await?;
    println!("removed session with slug {slug}");
    Ok(())
}
