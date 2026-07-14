//! `shellglass-keytool` — key management: mint a key, or derive a key's id.
//! Same behavior as `shellglass gen-key` / `shellglass print-id`.

use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(
    name = "shellglass-keytool",
    version,
    about = "Mint secret keys and derive their session / API ids"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Generate a secure random secret key and print it with its session id.
    GenKey {
        /// Mint a management-API key instead: print the key with its API id
        /// (for a hub's `--api-allow`).
        #[arg(long)]
        api: bool,
        #[command(flatten)]
        id_salt: shellglass::cli::IdSaltArg,
    },

    /// Print the session id for a key (to add to a hub's `--allow`).
    PrintId {
        #[command(flatten)]
        key: shellglass::cli::KeyArg,
        /// Print the key's API id instead (for a hub's `--api-allow`).
        #[arg(long)]
        api: bool,
        #[command(flatten)]
        id_salt: shellglass::cli::IdSaltArg,
    },
}

fn main() -> anyhow::Result<()> {
    match Cli::parse().cmd {
        Cmd::GenKey { api, id_salt } => shellglass::cli::gen_key(api, &id_salt),
        Cmd::PrintId { key, api, id_salt } => shellglass::cli::print_id(&key, api, &id_salt),
    }
}
