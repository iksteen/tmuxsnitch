//! `shellglass-gen-key` — mint a secret key and print it with its session id.
//! Same behavior as `shellglass gen-key`.

use clap::Parser;

#[derive(Parser, Debug)]
#[command(
    name = "shellglass-gen-key",
    version,
    about = "Generate a secure random secret key and print it with its session id"
)]
struct Cli {}

fn main() -> anyhow::Result<()> {
    let Cli {} = Cli::parse();
    shellglass::cli::gen_key()
}
