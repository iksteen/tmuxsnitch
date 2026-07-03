//! User configuration: rendering knobs, Kitty-style `symbol_map` font overrides,
//! and font sources (embedded file or installed system family).

use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Base font stack: one family, or a list tried in order. The browser picks,
    /// per character, the first family in the stack that has a glyph for it — so
    /// listing a Nerd Font after your text font emulates Kitty's fallback without
    /// any `symbol_map` ranges. Accepts a string or an array of strings.
    #[serde(default = "default_font", deserialize_with = "string_or_vec")]
    pub default_font: Vec<String>,
    /// Terminal font size in px.
    #[serde(default = "default_font_size")]
    pub font_size_px: f32,
    /// Line-height multiple relative to `font_size_px`.
    #[serde(default = "default_line_height")]
    pub line_height: f32,

    /// Codepoint-range → font overrides. First matching entry wins.
    #[serde(default)]
    pub symbol_map: Vec<SymbolMap>,
    /// Named font sources referenced by `default_font` / `symbol_map[].font`.
    #[serde(default)]
    pub fonts: HashMap<String, FontSource>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SymbolMap {
    /// e.g. `["U+E0A0-U+E0D4", "U+F000"]`.
    pub ranges: Vec<String>,
    /// Font family name (should exist as a key in `[fonts]`, or be system-installed).
    pub font: String,
}

/// A font is either embedded from a file (`path`) or referenced by an installed
/// family name (`system`). If neither is set, the family name is used verbatim.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct FontSource {
    pub path: Option<PathBuf>,
    /// Family name to hand fontconfig when it differs from the `[fonts]` key.
    pub system: Option<String>,
}

/// Family assumed installed system-wide for Nerd-Font symbol glyphs. It's part of
/// the built-in `default_font` fallback so icons render with no config; if it
/// isn't installed the browser just falls through (and it's exempt from the
/// unresolved-font warning, being our default rather than a user's typo).
pub(crate) const DEFAULT_SYMBOL_FONT: &str = "Symbols Nerd Font Mono";

fn default_font() -> Vec<String> {
    vec!["monospace".to_string(), DEFAULT_SYMBOL_FONT.to_string()]
}

/// Accept either `default_font = "Menlo"` or `default_font = ["Menlo", "NF"]`.
fn string_or_vec<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(String),
        Many(Vec<String>),
    }
    Ok(match OneOrMany::deserialize(d)? {
        OneOrMany::One(s) => vec![s],
        OneOrMany::Many(v) => v,
    })
}
fn default_font_size() -> f32 {
    14.0
}
fn default_line_height() -> f32 {
    1.2
}

impl Default for Config {
    fn default() -> Self {
        Config {
            default_font: default_font(),
            font_size_px: default_font_size(),
            line_height: default_line_height(),
            symbol_map: Vec::new(),
            fonts: HashMap::new(),
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Config> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading config {}", path.display()))?;
        let cfg: Config =
            toml::from_str(&text).with_context(|| format!("parsing config {}", path.display()))?;
        Ok(cfg)
    }

    /// Line height in px (`font_size_px * line_height`).
    pub fn line_height_px(&self) -> f32 {
        self.font_size_px * self.line_height
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_font_accepts_string_or_list() {
        let one: Config = toml::from_str("default_font = \"Menlo\"").unwrap();
        assert_eq!(one.default_font, vec!["Menlo"]);
        let many: Config = toml::from_str("default_font = [\"Menlo\", \"NF\"]").unwrap();
        assert_eq!(many.default_font, vec!["Menlo", "NF"]);
        let absent: Config = toml::from_str("").unwrap();
        assert_eq!(absent.default_font, vec!["monospace", DEFAULT_SYMBOL_FONT]);
    }
}
