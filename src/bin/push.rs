//! `shellglass-push` — the hub push client as its own binary.
//! Same flags as `shellglass push` (both wrap [`shellglass::cli::PushArgs`]).

use clap::Parser;

#[derive(Parser, Debug)]
#[command(
    name = "shellglass-push",
    version,
    about = "Mirror a terminal and push frames to a remote hub"
)]
struct Cli {
    #[command(flatten)]
    args: shellglass::cli::PushArgs,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    Cli::parse().args.run().await
}
