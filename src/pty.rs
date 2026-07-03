//! PTY backend: run an interactive command in a pseudo-terminal that you drive
//! from your own terminal, while mirroring its screen to the browser — the
//! `script(1)` model. Unlike the tmux backend there are no panes: one PTY feeds a
//! single [`vt100::Parser`], rendered as one full-window fragment by the shared
//! renderer with the same 30fps cap. Unix only (raw mode + `TIOCGWINSZ`).

use crate::config::Config;
use crate::fonts::Resolver;
use crate::model::{Pane, PaneGeom, Window};
use crate::render;
use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::watch;

/// Same 30fps ceiling as the tmux backend (see `live::MIN_FRAME`).
const MIN_FRAME: Duration = Duration::from_millis(33);

/// One update the render thread applies to the parser.
enum Msg {
    Data(Vec<u8>),
    Resize(u16, u16), // rows, cols
}

/// Start an interactive PTY session running `command` and return a receiver of the
/// latest rendered `#screen` fragment. Puts the terminal in raw mode, bridges
/// stdin/stdout to the PTY, and exits the process when the command exits.
pub fn start(
    command: &[String],
    config: Arc<Config>,
    resolver: Arc<Resolver>,
) -> Result<watch::Receiver<String>> {
    let (cols, rows) = term_size().unwrap_or((80, 24));
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .context("opening pty")?;

    let mut builder = CommandBuilder::new(&command[0]);
    builder.args(&command[1..]);
    // The child is a real terminal (the PTY slave); advertise a capable TERM.
    if std::env::var_os("TERM").is_none() {
        builder.env("TERM", "xterm-256color");
    }
    let mut child = pair.slave.spawn_command(builder).context("spawning command")?;
    drop(pair.slave); // parent doesn't hold the slave open

    let master = pair.master;
    let mut reader = master.try_clone_reader().context("cloning pty reader")?;
    let mut writer = master.take_writer().context("taking pty writer")?;

    // Raw mode so keystrokes/control chars reach the child unmodified.
    let raw = RawMode::enable();
    let (msg_tx, msg_rx) = mpsc::channel::<Msg>();
    let (frame_tx, frame_rx) = watch::channel(render_screen(&new_parser(rows, cols), &config, &resolver));

    // Output pump: PTY → our stdout (immediately, so typing feels live) and → the
    // render thread (throttled). A copy to both; stdout must never wait on rendering.
    {
        let msg_tx = msg_tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut stdout = std::io::stdout();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = stdout.write_all(&buf[..n]);
                        let _ = stdout.flush();
                        if msg_tx.send(Msg::Data(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }

    // Input pump: our stdin → PTY.
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut stdin = std::io::stdin();
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if writer.write_all(&buf[..n]).is_err() {
                        break;
                    }
                    let _ = writer.flush();
                }
            }
        }
    });

    // Size poller: reflect terminal resizes into the PTY + parser. Owns the master
    // (only it resizes). ponytail: a 1s poll instead of a SIGWINCH handler (async-
    // signal-safety); resize shows within a second — swap in a signal handler if
    // that lag ever matters.
    {
        let msg_tx = msg_tx.clone();
        std::thread::spawn(move || {
            let mut last = (cols, rows);
            loop {
                std::thread::sleep(Duration::from_secs(1));
                match term_size() {
                    Some(size) if size != last => {
                        last = size;
                        let (c, r) = size;
                        let _ = master.resize(PtySize { rows: r, cols: c, pixel_width: 0, pixel_height: 0 });
                        if msg_tx.send(Msg::Resize(r, c)).is_err() {
                            break;
                        }
                    }
                    _ => {}
                }
            }
        });
    }

    // Render thread: owns the parser, coalesces bursts, renders at most every
    // MIN_FRAME — same rate-limiting shape as the tmux backend.
    std::thread::spawn(move || {
        let mut parser = new_parser(rows, cols);
        let mut last_frame = Instant::now();
        let mut dirty = false;
        loop {
            let next = if dirty {
                match msg_rx.recv_timeout(MIN_FRAME) {
                    Ok(m) => Some(m),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            } else {
                match msg_rx.recv() {
                    Ok(m) => Some(m),
                    Err(_) => break,
                }
            };
            if let Some(m) = next {
                apply(&mut parser, m);
                dirty = true;
                while last_frame.elapsed() < MIN_FRAME {
                    match msg_rx.try_recv() {
                        Ok(m) => apply(&mut parser, m),
                        Err(_) => break,
                    }
                }
            }
            if dirty && last_frame.elapsed() >= MIN_FRAME {
                let _ = frame_tx.send(render_screen(&parser, &config, &resolver));
                dirty = false;
                last_frame = Instant::now();
            }
        }
    });

    // When the command exits, restore the terminal and quit (std::process::exit
    // skips destructors, so restore explicitly here).
    std::thread::spawn(move || {
        let _ = child.wait();
        raw.restore();
        std::process::exit(0);
    });

    Ok(frame_rx)
}

fn new_parser(rows: u16, cols: u16) -> vt100::Parser {
    vt100::Parser::new(rows, cols, 0)
}

fn apply(parser: &mut vt100::Parser, msg: Msg) {
    match msg {
        Msg::Data(b) => parser.process(&b),
        Msg::Resize(rows, cols) => parser.screen_mut().set_size(rows, cols),
    }
}

/// Render the single PTY screen as a one-pane window fragment.
fn render_screen(parser: &vt100::Parser, config: &Config, resolver: &Resolver) -> String {
    let screen = parser.screen();
    let (rows, cols) = screen.size();
    let window = Window {
        width: cols,
        height: rows,
        panes: vec![Pane {
            geom: PaneGeom { id: "%0".into(), left: 0, top: 0, width: cols, height: rows, active: true },
            grid: crate::parse::grid_from_screen(screen),
        }],
    };
    render::render_fragment(&window, config, resolver)
}

/// Our controlling terminal's size as (cols, rows), if stdin is a tty.
fn term_size() -> Option<(u16, u16)> {
    // SAFETY: ioctl into a zeroed winsize; we only read the result on success.
    unsafe {
        let mut ws: libc::winsize = std::mem::zeroed();
        if libc::ioctl(libc::STDIN_FILENO, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0 {
            Some((ws.ws_col, ws.ws_row))
        } else {
            None
        }
    }
}

/// Puts stdin in raw mode for the session and restores it on `restore()`.
struct RawMode {
    orig: Option<libc::termios>,
}

impl RawMode {
    fn enable() -> RawMode {
        // SAFETY: standard termios raw-mode dance on the real stdin fd.
        unsafe {
            let mut t: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(libc::STDIN_FILENO, &mut t) != 0 {
                return RawMode { orig: None }; // not a tty (e.g. piped) — leave as-is
            }
            let orig = t;
            libc::cfmakeraw(&mut t);
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &t);
            RawMode { orig: Some(orig) }
        }
    }

    fn restore(&self) {
        if let Some(orig) = self.orig {
            // SAFETY: restoring the previously-saved termios on the same fd.
            unsafe {
                libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &orig);
            }
        }
    }
}
