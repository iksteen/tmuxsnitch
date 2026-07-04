//! Push client: run the live PTY pipeline locally, but stream its frames to a
//! remote hub instead of serving them.
//!
//! It registers with the hub (`/register`, retrying until the hub is reachable)
//! **before** starting the PTY and the command — a down hub never leaves a
//! half-started session, and a rejected key fails cleanly before the terminal is
//! taken over. It then opens a single long-lived `/stream` POST and writes
//! length-prefixed wire messages into its body: a full picture first, then only
//! the deltas against what was already sent (the exact messages the hub forwards
//! to its viewers verbatim). Because they flow over one persistent connection,
//! the client never blocks on a per-frame HTTP round-trip — that round-trip is
//! what made a remote hub feel laggy. If the connection drops (hub restart,
//! network blip) it re-registers and reopens with a fresh full.

use crate::config::Config;
use crate::diff;
use crate::fonts::{self, FontFile, Resolver};
use crate::model::Frame;
use crate::proto::{KEY_HEADER, RegisterBody, frame_encode};
use crate::render;
use anyhow::{Context, Result, bail};
use bytes::Bytes;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio_stream::wrappers::ReceiverStream;

// ponytail: 8 positional args, one call site — an args struct would be ceremony
// for no reader benefit. Bundle them if a second caller ever appears.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    base_url: String,
    key: String,
    id: String,
    config: Arc<Config>,
    resolver: Arc<Resolver>,
    fonts: Arc<Vec<FontFile>>,
    template: Arc<String>,
    // Starts the PTY backend (raw mode, the command itself). Invoked only after the
    // hub has accepted a registration, so a down or misconfigured hub is reported —
    // and retried — before the command runs and the terminal is taken over.
    start: impl FnOnce() -> Result<(watch::Receiver<Arc<Frame>>, crate::pty::Notifier)>,
) -> Result<()> {
    let base = base_url.trim_end_matches('/').to_string();
    let http = reqwest::Client::new();
    // The view URL is printed by `main` before any backend (and any PTY raw mode)
    // starts. The hub serves our fonts under this session's id, so bake that URL
    // prefix into the @font-face CSS and upload the font bytes alongside it.
    let font_css = render::font_face_css(&fonts, &format!("/s/{id}/fonts/"));
    let css = render::head_css(&font_css, &config);
    let reg = RegisterBody {
        css,
        template: (*template).clone(),
        render_cfg: render::render_config_json(&config, &resolver),
        fonts: fonts::font_assets(&fonts),
    };
    let reg_body = Bytes::from(serde_json::to_vec(&reg).context("encoding register payload")?);

    let mut start = Some(start);
    // The PTY backend, started after the first successful registration. Until then
    // outage reports go to stderr (the terminal is still ours); after, the notifier
    // pauses/restores the raw session cleanly.
    let mut backend: Option<(watch::Receiver<Arc<Frame>>, crate::pty::Notifier)> = None;
    // Whether we've reported the hub as unreachable (so we report down/up once per
    // outage, not every retry).
    let mut down = false;
    loop {
        // Register (also re-registers the CSS after a hub restart) before opening
        // the stream. register is a clean request/response that fails fast when the
        // hub is down, so the reconnect loop spins here — cheaply — until it's back,
        // instead of hanging on a stream POST to an unreachable hub. Startup and
        // mid-session failures take the same path; only a rejected key is fatal
        // (retrying can't fix it).
        let notifier = backend.as_ref().map(|(_, n)| n);
        match register(&http, &base, &key, &reg_body).await {
            Reg::Ok => {
                if down {
                    report_up(notifier);
                    down = false;
                }
                if backend.is_none() {
                    // Hub reachable and key accepted — now take the terminal and
                    // launch the command.
                    backend = Some(start.take().expect("started once")()?);
                }
            }
            Reg::Forbidden => bail!(
                "hub rejected this key: register its session id on the hub \
                 (run `print-id --key <secret>`, add it to the hub's --allow)"
            ),
            // Retry either way, but say which it is — an HTTP response means the hub
            // is reachable, so don't call it "unreachable".
            Reg::Unreachable(e) => {
                if !down {
                    report_down(notifier, &format!("hub unreachable ({e}); retrying"));
                    down = true;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
            Reg::Rejected(s) => {
                if !down {
                    report_down(
                        notifier,
                        &format!("hub rejected the request (HTTP {s}); retrying"),
                    );
                    down = true;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
        }

        let (rx, _) = backend.as_mut().expect("backend started on first Ok");
        match stream_push(&http, &base, &key, rx).await {
            End::LiveDone => break, // PTY backend ended — nothing left to push
            End::Disconnected => {
                // Transient — let the next register decide if it's a real outage, so
                // a quick reconnect doesn't flash a pause in the terminal.
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
    Ok(())
}

/// Report the hub as unreachable: pause+announce in the terminal (PTY running) or
/// log to stderr (still ours before the first successful registration).
fn report_down(notifier: Option<&crate::pty::Notifier>, msg: &str) {
    match notifier {
        Some(n) => n.hub_down(msg),
        None => eprintln!("shellglass: {msg}"),
    }
}

/// Report the hub as reachable again: restore the terminal, or stay quiet pre-PTY.
fn report_up(notifier: Option<&crate::pty::Notifier>) {
    if let Some(n) = notifier {
        n.hub_up();
    }
}

enum End {
    LiveDone,
    Disconnected,
}

/// Length-prefix a wire message for the push body.
fn encode_msg(msg: &str) -> Bytes {
    Bytes::from(frame_encode(msg))
}

/// Open one streaming POST and pump frames until either the live task ends or the
/// connection breaks.
async fn stream_push(
    http: &reqwest::Client,
    base: &str,
    key: &str,
    rx: &mut watch::Receiver<Arc<Frame>>,
) -> End {
    let (tx, body_rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(4);
    let body = reqwest::Body::wrap_stream(ReceiverStream::new(body_rx));
    let request = http
        .post(format!("{base}/stream"))
        .header(KEY_HEADER, key)
        .body(body)
        .send();

    // Feeder: this connection starts with a full picture (the hub knows nothing, or
    // only a stale matrix from before a drop), then streams only the deltas against
    // what we've already sent — the same wire messages the hub forwards verbatim to
    // its viewers. A resize is a layout change, which encode_delta turns into a
    // fresh full automatically. A bounded channel + the watch's latest-only
    // semantics give backpressure: if the network stalls, we hold and coalesce, and
    // the next delta is computed against the last frame actually sent.
    let feeder = async {
        let mut prev = rx.borrow_and_update().clone();
        if tx
            .send(Ok(encode_msg(&diff::full_message(&prev))))
            .await
            .is_err()
        {
            return false; // body consumer gone (connection dropped)
        }
        loop {
            if rx.changed().await.is_err() {
                return true; // live task ended
            }
            let next = rx.borrow_and_update().clone();
            if let Some(msg) = diff::encode_delta(&prev, &next)
                && tx.send(Ok(encode_msg(&msg))).await.is_err()
            {
                return false;
            }
            prev = next;
        }
    };

    tokio::select! {
        // The request future resolves only when the body ends or the connection
        // breaks (the hub responds after reading the stream) — treat as a drop.
        _ = request => End::Disconnected,
        live_done = feeder => if live_done { End::LiveDone } else { End::Disconnected },
    }
}

/// Outcome of a register attempt. `Forbidden` is fatal (retrying can't fix a key
/// the hub doesn't allow); the two failure kinds are always retried — at startup
/// that means the command doesn't launch until the hub is reachable. They're
/// split so we word them honestly: `Unreachable` means no HTTP response (hub
/// down / network), `Rejected` means the hub answered with a bad status — cause
/// left unstated (could be version skew, a proxy, a transient hub error).
enum Reg {
    Ok,
    Forbidden,
    Unreachable(anyhow::Error),
    Rejected(u16),
}

async fn register(http: &reqwest::Client, base: &str, key: &str, body: &Bytes) -> Reg {
    let resp = match http
        .post(format!("{base}/register"))
        .header(KEY_HEADER, key)
        .header("content-type", "application/json")
        .body(body.clone())
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return Reg::Unreachable(e.into()),
    };
    match resp.status().as_u16() {
        200..=299 => Reg::Ok,
        403 => Reg::Forbidden,
        s => Reg::Rejected(s),
    }
}
