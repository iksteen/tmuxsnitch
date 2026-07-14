//! Timestamped native-stream session recorder.
//!
//! A recording (`.sgs`, one JSONL file) is a **timestamped `/push` transcript**:
//! a header line, then one `[ms_since_start, <message>]` line per message, where
//! the message is exactly what travels the push WebSocket — the register JSON,
//! `{"blob":…}` image payloads, and [`crate::diff`] wire messages — spliced in
//! verbatim (they are already JSON; no re-encoding, no new envelope). Consumers
//! dispatch messages exactly like the hub does: first is the register, a `blob`
//! key is an image payload, everything else is a wire message. Being the native
//! format, a recording is self-contained (CSS/fonts/template/images included)
//! and replayable at full mirror fidelity by any future player without this
//! module knowing about it.
//!
//! Both serving modes drive it with `--record-dir`: the hub taps its `/push`
//! socket loop (one recorder per push connection, so each register→disconnect
//! span is one file under `<record-dir>/<session-id>/`, enumerable through the
//! management API), while serve — which has no socket to tap — synthesizes the
//! same shape from its own state ([`record_live`]): a register built like the
//! push client's, then snapshot-then-ticks like a connecting viewer.

use crate::model::Frame;
use crate::{diff, proto};
use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, mpsc, oneshot};

/// Feeds one recording. `event` is non-blocking (unbounded channel to the
/// writer task), so a slow disk never stalls the caller's socket loop;
/// dropping the last `Recorder` ends the file cleanly.
// ponytail: unbounded channel — a terminal stream at the 30fps cap is far
// below any disk; bound it if recordings ever outrun storage.
pub struct Recorder {
    tx: mpsc::UnboundedSender<(u64, String)>,
    start: Instant,
}

impl Recorder {
    /// Append one push-protocol message (register / blob / wire), stamped with
    /// milliseconds since the recording started.
    pub fn event(&self, msg: &str) {
        let dt = u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX);
        // A send after the writer died (disk error) is deliberately a no-op.
        let _ = self.tx.send((dt, msg.to_string()));
    }
}

/// Start a recording into a new timestamped `.sgs` file under `dir` (created
/// if missing). Returns the feeder plus the writer task's handle, resolving to
/// the path written once the last `Recorder` drops — or to the write error.
/// The writer prints nothing: in serve mode the terminal belongs to the
/// mirrored session, so logging is the caller's choice.
pub fn start(dir: PathBuf) -> (Recorder, tokio::task::JoinHandle<Result<PathBuf>>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = tokio::spawn(write_stream(dir, rx));
    (
        Recorder {
            tx,
            start: Instant::now(),
        },
        handle,
    )
}

async fn write_stream(
    dir: PathBuf,
    mut rx: mpsc::UnboundedReceiver<(u64, String)>,
) -> Result<PathBuf> {
    tokio::fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("creating recording directory {}", dir.display()))?;
    let unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let path = dir.join(format!("{}.sgs", unix.as_millis()));
    // create_new: two recorders racing the same directory in one millisecond
    // must not interleave into one file.
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .await
        .with_context(|| format!("creating stream file {}", path.display()))?;
    let header = serde_json::json!({
        "shellglass": 1,
        // The wire protocol the recorded messages speak, so a future player
        // knows how to decode without guessing.
        "protocol": proto::PROTOCOL_VERSION,
        "start": u64::try_from(unix.as_millis()).unwrap_or(u64::MAX),
    });
    write_line(&mut file, &format!("{header}")).await?;
    while let Some((dt, msg)) = rx.recv().await {
        // Splice the message in verbatim — it is already JSON; re-encoding
        // would only escape it into a string.
        write_line(&mut file, &format!("[{dt},{msg}]")).await?;
    }
    file.flush().await.ok();
    Ok(path)
}

/// One stream line = one write call, so an abrupt process death can at worst
/// truncate the final line (readers tolerate a torn tail), never interleave.
async fn write_line(file: &mut tokio::fs::File, line: &str) -> Result<()> {
    let mut line = line.to_string();
    line.push('\n');
    file.write_all(line.as_bytes())
        .await
        .context("writing stream event")
}

/// Serve-mode driver: emit the synthesized `register`, then follow `live`
/// exactly like a connecting viewer — subscribe, snapshot (the memoized full),
/// then every tick's already-encoded wire message — until `stop` fires (or its
/// sender drops) or the publisher goes away. Image payloads are emitted as
/// `{"blob":…}` lines before the first frame that references them, the push
/// client's own ordering contract.
pub async fn record_live(
    live: Arc<diff::Live>,
    register: String,
    rec: Recorder,
    mut stop: oneshot::Receiver<()>,
) {
    let mut ticks = live.ticks();
    rec.event(&register);
    let mut seen = std::collections::HashSet::new();
    emit_blobs(&live, &rec, &mut seen);
    rec.event(&live.snapshot());
    loop {
        tokio::select! {
            r = ticks.recv() => match r {
                Ok((_, msg)) => {
                    emit_blobs(&live, &rec, &mut seen);
                    rec.event(&msg);
                }
                // Fell behind a burst: the skipped deltas are unrecoverable,
                // so re-anchor the stream on a fresh full snapshot.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    emit_blobs(&live, &rec, &mut seen);
                    rec.event(&live.snapshot());
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = &mut stop => break,
        }
    }
}

/// Record any not-yet-seen image payloads on the current frame, as the same
/// `{"blob":…}` message a push client would send. Reading the latest frame may
/// run slightly ahead of the tick being recorded — that only makes a blob
/// arrive earlier than its first reference, which the FIFO contract permits.
fn emit_blobs(live: &diff::Live, rec: &Recorder, seen: &mut std::collections::HashSet<String>) {
    let Frame::Screen(g) = &*live.frame();
    for (hash, blob) in &g.image_data {
        if seen.insert(hash.clone()) {
            let msg = proto::BlobMsg {
                blob: proto::BlobBody {
                    m: blob.mime.clone(),
                    d: B64.encode(&blob.bytes),
                },
            };
            rec.event(&serde_json::to_string(&msg).expect("blob message serializes"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::grid_from_capture;

    fn screen(rows: &[&str], cols: u16) -> Arc<Frame> {
        let joined = rows.join("\n");
        Arc::new(Frame::Screen(grid_from_capture(
            &joined,
            cols,
            u16::try_from(rows.len()).unwrap(),
        )))
    }

    /// Parse a stream file into (header, events); asserts every line is JSON
    /// and every event is a `[ms, message]` pair with monotonic timestamps.
    fn parse_stream(path: &std::path::Path) -> (serde_json::Value, Vec<serde_json::Value>) {
        let text = std::fs::read_to_string(path).unwrap();
        let mut lines = text.lines();
        let header: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        let events: Vec<serde_json::Value> = lines
            .map(|l| serde_json::from_str(l).expect("event line is JSON"))
            .collect();
        let times: Vec<u64> = events
            .iter()
            .map(|e| e[0].as_u64().expect("ms timestamp"))
            .collect();
        assert!(
            times.windows(2).all(|w| w[0] <= w[1]),
            "monotonic: {times:?}"
        );
        (header, events)
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sg-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[tokio::test]
    async fn writes_header_and_verbatim_timestamped_messages() {
        let dir = scratch("record-writer");
        let (rec, done) = start(dir.clone());
        rec.event(r#"{"css":"x"}"#);
        rec.event(r#"{"blob":{"m":"image/png","d":"AA=="}}"#);
        drop(rec); // last feeder gone → file closes cleanly
        let path = done.await.unwrap().unwrap();
        assert_eq!(path.extension().unwrap(), "sgs");

        let (header, events) = parse_stream(&path);
        assert_eq!(header["shellglass"], 1);
        assert_eq!(
            header["protocol"],
            u64::from(crate::proto::PROTOCOL_VERSION)
        );
        assert!(header["start"].as_u64().unwrap() > 0, "wall-clock anchor");
        assert_eq!(events.len(), 2);
        // Messages ride verbatim as JSON values, not re-escaped strings.
        assert_eq!(events[0][1]["css"], "x");
        assert_eq!(events[1][1]["blob"]["m"], "image/png");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn record_live_emits_register_snapshot_then_deltas() {
        let live = diff::Live::new(screen(&["ab", "cd"], 2));
        let dir = scratch("record-live");
        let (rec, done) = start(dir.clone());
        let (tx, rx) = oneshot::channel();
        let task = tokio::spawn(record_live(
            Arc::clone(&live),
            r#"{"css":"","template":"t"}"#.to_string(),
            rec,
            rx,
        ));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        live.publish(screen(&["ab", "cX"], 2));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let _ = tx.send(());
        task.await.unwrap();
        let path = done.await.unwrap().unwrap();

        let (_, events) = parse_stream(&path);
        assert!(events.len() >= 3, "register + full + delta: {events:?}");
        // The transcript dispatches like the hub: first message is the register…
        assert_eq!(events[0][1]["template"], "t");
        // …then a full frame (key `d`), then the published change as a wire
        // message — any of the payload shapes (`d` full, `r` diff, `c` cell,
        // `l` line; a one-cell change encodes as `c`).
        assert!(events[1][1].get("d").is_some(), "snapshot full: {events:?}");
        let delta = &events[2][1];
        assert!(
            ["d", "r", "c", "l"].iter().any(|k| delta.get(k).is_some()),
            "wire message for the change: {delta}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn record_live_emits_blobs_before_referencing_frames() {
        let mut frame = screen(&["img"], 3);
        {
            let Frame::Screen(g) = Arc::get_mut(&mut frame).unwrap();
            g.image_data.insert(
                "k1".into(),
                crate::model::ImageBlob {
                    mime: "image/png".into(),
                    bytes: bytes::Bytes::from_static(b"\x89PNG"),
                },
            );
        }
        let live = diff::Live::new(frame);
        let dir = scratch("record-blobs");
        let (rec, done) = start(dir.clone());
        let (tx, rx) = oneshot::channel();
        let task = tokio::spawn(record_live(Arc::clone(&live), "{}".to_string(), rec, rx));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let _ = tx.send(());
        task.await.unwrap();
        let path = done.await.unwrap().unwrap();

        let (_, events) = parse_stream(&path);
        // register, blob, snapshot — the blob precedes the frame that
        // references it (the push client's FIFO contract).
        let kinds: Vec<&str> = events
            .iter()
            .map(|e| {
                if e[1].get("blob").is_some() {
                    "blob"
                } else if e[1].get("d").is_some() {
                    "full"
                } else {
                    "other"
                }
            })
            .collect();
        let blob_at = kinds.iter().position(|k| *k == "blob").expect("has blob");
        let full_at = kinds.iter().position(|k| *k == "full").expect("has full");
        assert!(blob_at < full_at, "blob before its frame: {kinds:?}");
        assert_eq!(events[blob_at][1]["blob"]["m"], "image/png");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
