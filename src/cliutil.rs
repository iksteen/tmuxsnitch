//! Shared plumbing for the hub-facing CLI clients ([`crate::apictl`],
//! [`crate::recctl`]): HTTP client construction, capped body reads, the
//! recording-name gate, and the streamed recording download/print helpers.
//! Each client keeps its own error mapping — the credential hints differ
//! (API key vs session key) — but the mechanics live once, here.

use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};

pub(crate) fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .build()
        .context("building HTTP client")
}

/// Read a hub response body into a String, capped so a hostile/MITM hub can't
/// OOM the CLI with an unbounded (or lying-`Content-Length`) body —
/// `Response::text` buffers the whole thing with no ceiling. Control-plane
/// responses are tiny; recordings don't come through here (see
/// [`save_stream`]).
pub(crate) async fn body_capped(mut res: reqwest::Response) -> Result<String> {
    const MAX: usize = 8 << 20;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = res.chunk().await.context("reading the hub response")? {
        if buf.len() + chunk.len() > MAX {
            bail!("hub response body exceeds {} MiB — refusing", MAX >> 20);
        }
        buf.extend_from_slice(&chunk);
    }
    String::from_utf8(buf).context("hub response body is not valid UTF-8")
}

/// The name shape the hub's recorder generates (`<millis>.sgs`). Checked
/// client-side too, so a typo'd name is a clear local error instead of a URL
/// with path separators in it.
fn valid_stream_name(name: &str) -> bool {
    name.strip_suffix(".sgs")
        .is_some_and(|stem| !stem.is_empty() && stem.bytes().all(|b| b.is_ascii_digit()))
}

pub(crate) fn checked_name(name: &str) -> Result<&str> {
    if !valid_stream_name(name) {
        bail!("recording names look like <millis>.sgs, got {name:?} (see `list`)");
    }
    Ok(name)
}

/// Stream a recording response to its output: `-` writes to stdout (quietly
/// tolerating a closed pipe, like any unix filter); a path (default: the
/// recording's name in the current directory) is created fresh — an existing
/// file is an error, never clobbered.
pub(crate) async fn save_stream(
    mut res: reqwest::Response,
    name: &str,
    output: Option<&Path>,
) -> Result<()> {
    let to_stdout = output.is_some_and(|p| p.as_os_str() == "-");
    let path: Option<PathBuf> = if to_stdout {
        None
    } else {
        Some(output.map_or_else(|| PathBuf::from(name), Path::to_path_buf))
    };
    let mut out: Box<dyn std::io::Write> = match &path {
        None => Box::new(std::io::stdout().lock()),
        Some(p) => Box::new(
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(p)
                .with_context(|| format!("creating {} (exists already?)", p.display()))?,
        ),
    };
    let mut bytes: u64 = 0;
    while let Some(chunk) = res.chunk().await.context("downloading the recording")? {
        match out.write_all(&chunk) {
            Ok(()) => bytes += chunk.len() as u64,
            // stdout piped into a pager/head that closed early: not an error,
            // just stop quietly like any well-behaved unix filter.
            Err(e) if to_stdout && e.kind() == std::io::ErrorKind::BrokenPipe => return Ok(()),
            Err(e) => return Err(e).context("writing the recording"),
        }
    }
    out.flush().context("writing the recording")?;
    if let Some(p) = path {
        eprintln!("saved {} ({bytes} bytes)", p.display());
    }
    Ok(())
}

/// Print a recordings listing (`[{name, bytes}]`, as both the owner and the
/// management routes return it), oldest first — the hub sorts.
pub(crate) fn print_recordings(body: &str) -> Result<()> {
    let recordings: Vec<serde_json::Value> =
        serde_json::from_str(body).context("parsing the recording list")?;
    if recordings.is_empty() {
        println!("no recordings");
        return Ok(());
    }
    println!("{:<20} BYTES", "NAME");
    for r in recordings {
        println!(
            "{:<20} {}",
            crate::proto::neuter(r["name"].as_str().unwrap_or("?")),
            r["bytes"].as_u64().unwrap_or(0),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_validated_before_touching_the_url() {
        assert!(valid_stream_name("1752574530123.sgs"));
        assert!(!valid_stream_name("../etc.sgs"), "separators rejected");
        assert!(!valid_stream_name("100.cast"), "wrong suffix");
        assert!(!valid_stream_name(".sgs"), "empty stem");
        assert!(checked_name("nope").is_err());
        assert_eq!(checked_name("1.sgs").unwrap(), "1.sgs");
    }
}
