//! shellglass — mirror an interactive terminal command as live HTML.
//!
//! One library, several binaries: the full multi-call `shellglass` CLI plus
//! slim per-mode executables (see the `[[bin]]` targets + `[features]` in
//! `Cargo.toml`). Every binary dispatches through [`cli`], so flags and
//! behavior can't drift between the full CLI and the per-mode ones.

#[cfg(feature = "ssh-view")]
pub mod ansi;
#[cfg(feature = "sessions")]
pub mod apictl;
pub mod cli;
#[cfg(feature = "push")]
pub mod client;
#[cfg(feature = "mirror")]
pub mod config;
pub mod diff;
pub mod fonts;
#[cfg(feature = "hub")]
pub mod hub;
#[cfg(feature = "mirror")]
pub mod images;
pub mod model;
pub mod parse;
pub mod proto;
#[cfg(feature = "mirror")]
pub mod pty;
pub mod render;
#[cfg(feature = "serve")]
pub mod server;
#[cfg(feature = "ssh-view")]
pub mod ssh;
