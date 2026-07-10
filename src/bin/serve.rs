//! `shellglass-serve` — the standalone local mirror as its own binary.
//! Same flags as `shellglass serve` (both wrap [`shellglass::cli::ServeArgs`]).

use clap::Parser;

#[derive(Parser, Debug)]
#[command(
    name = "shellglass-serve",
    version,
    about = "Mirror a terminal locally: serve the live HTML viewer over HTTP"
)]
struct Cli {
    #[command(flatten)]
    args: shellglass::cli::ServeArgs,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    Cli::parse().args.run().await
}
