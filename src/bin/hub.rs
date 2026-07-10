//! `shellglass-hub` — the hub as its own binary.
//! Same flags as `shellglass hub` (both wrap [`shellglass::cli::HubArgs`]).

use clap::Parser;

#[derive(Parser, Debug)]
#[command(
    name = "shellglass-hub",
    version,
    about = "Receive pushes from shellglass clients and re-serve their sessions"
)]
struct Cli {
    #[command(flatten)]
    args: shellglass::cli::HubArgs,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    Cli::parse().args.run().await
}
