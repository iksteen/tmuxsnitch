//! `shellglass-print-id` — print the session id for a key.
//! Same behavior as `shellglass print-id`.

use clap::Parser;

#[derive(Parser, Debug)]
#[command(
    name = "shellglass-print-id",
    version,
    about = "Print the session id for a key (to add to a hub's --allow)"
)]
struct Cli {
    #[command(flatten)]
    key: shellglass::cli::KeyArg,
}

fn main() -> anyhow::Result<()> {
    let Cli { key } = Cli::parse();
    shellglass::cli::print_id(&key)
}
