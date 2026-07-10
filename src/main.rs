//! The full multi-call `shellglass` binary: every compiled-in mode as a
//! subcommand. The per-mode binaries live in `src/bin/`; all of them dispatch
//! through [`shellglass::cli`].

use clap::Parser;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    shellglass::cli::Cli::parse().run().await
}
