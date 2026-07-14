//! `shellglass-recordings` — manage your own session recordings on a hub.
//! Same flags as `shellglass recordings` (both wrap
//! [`shellglass::cli::RecordingsArgs`]).

use clap::Parser;

#[derive(Parser, Debug)]
#[command(
    name = "shellglass-recordings",
    version,
    about = "Manage your own session recordings on a hub: list, get, delete"
)]
struct Cli {
    #[command(flatten)]
    args: shellglass::cli::RecordingsArgs,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    Cli::parse().args.run().await
}
