# Enhancement roadmap

Ordered plan for the work unlocked by vendoring `crates/vt100` (see the provenance
header in its `Cargo.toml`), plus the cross-layer features that build on it. Every
claim below was verified against the vendored 0.16.2 source at writing time
(2026-07). Work top to bottom within a phase; phases are priority tiers, not
strict dependencies — the only hard edge is called out on the items themselves.

Ground rules that apply throughout:

- **Mirror fidelity is the bar**: render in the browser exactly what the local
  terminal shows — never more, never less. A feature the local terminal doesn't
  render (e.g. OSC 8 on a dumb terminal) must not appear in the mirror.
- **Vendored-crate patches** land as separate commits and are listed in
  `crates/vt100/Cargo.toml`'s provenance header (keep it current).
- **Wire changes**: purely additive optional keys need no salt bump; anything an
  old decoder would *misread* does (see the `SALT` comment in `proto.rs`).

## Phase 1 — quick wins ✅ (all landed 2026-07-09)

Small, self-contained, each in the established SCOSC/SCORC pattern
(`screen.rs`/`perform.rs` + tests in the vendored suite + a consumer-side pin
where it matters). Landed as: telemetry `b6a0a6a`, REP `4c0df56`,
movement + tab stops `4c4e809`.

1. **Unhandled-sequence telemetry.** The parser is constructed with default
   callbacks, so unhandled CSI/escape/OSC vanish silently — which is exactly why
   the SCOSC gap shipped unnoticed. Implement `vt100::Callbacks` in `pty.rs`
   with `unhandled_csi`/`unhandled_escape`/`unhandled_osc`/`unhandled_char`
   recording once per distinct sequence kind (never per-occurrence — a busy TUI
   can emit thousands per second). **Sink constraint**: in serve/push mode we
   own the terminal (raw mode + tee), so NOTHING may be printed while the
   session runs — a stray log line lands inside the mirrored screen. Instead:
   accumulate the (tiny, deduplicated) set in memory and print one summary line
   to stderr on exit, *after* raw mode is restored and the screen thread has
   quiesced ("shellglass: N escape sequences not mirrored: CSI b, OSC 9 —
   please report"). For live debugging of long-running sessions, an env-gated
   file sink (`SHELLGLASS_SEQ_LOG=<path>`, append + flush per new kind) — a
   file, never the tty. Do this FIRST: it converts every remaining gap on this
   page — and future ones — from a user bug report into an exit line.

2. **REP (`CSI b`, repeat preceding graphic character).** Missing from the CSI
   dispatch, and both `xterm-256color` and `xterm-kitty` terminfo advertise
   `rep`, so ncurses ≥ 6 apps (vim, htop, tmux redraws) compress character runs
   into REP today — the mirror silently loses them. Requires remembering the
   last printed char on the screen (cleared on cursor movement/control, per
   xterm). Highest-value single fix: live content loss, a few lines.

3. **Cursor-movement batch.** One-liners each, missing from dispatch: `CSI f`
   (HVP, the CUP alias), `CSI Z` (CBT), `CSI I` (CHT), ``CSI ` `` (HPA),
   `CSI a` (HPR), `CSI e` (VPR). Plus real tab stops: `ESC H` (HTS) and
   `CSI g` (TBC) with a tab-stop table in `grid.rs` — `tab()` currently assumes
   fixed 8-column stops, and CBT/CHT need the table anyway. Wrong cursor
   position is the bug class of the powerline incident; this batch is cheap
   insurance against the rest of the family. One commit.

## Phase 1.5 — direct phase-1 fallout ✅ (landed 2026-07-09: DECSTR `fbbe4a1`, sync output `11a8eb1`)

The very first telemetry runs (item 1) surfaced both of these in trivial test
sessions, so real workloads hit them constantly. Quick-win sized; do before
phase 2.

1. **DECSTR (`CSI ! p`, soft terminal reset).** Small and mechanical: restore
   the defined subset of state without touching screen content or cursor
   position — SGR to normal, scroll margins to full screen, origin mode off,
   autowrap on, insert→replace mode, cursor visible, saved-cursor state
   cleared, keypad/cursor-keys to normal. All of it already exists as state in
   the vendored `Screen`/`Grid`; needs a `Some(b'!')` intermediate branch in
   `csi_dispatch` (only bare and `?` exist). The care is the checklist —
   match xterm's documented reset list exactly, one test assertion per aspect.
   Without it, apps that soft-reset on exit leave the mirror with stale
   margins/attrs the local terminal already dropped.

2. **Synchronized output (`CSI ? 2026 h/l`).** neovim and modern tmux wrap
   redraws in BSU/ESU so the terminal presents atomically; kitty honors it
   locally, so a ≤30fps frame snapshot landing *mid-redraw* shows the browser
   a torn frame the local screen never displayed — a transient but real
   fidelity violation, on every redraw of every 2026-aware app. Vendored side
   is trivial (mode bit in the existing `?h`/`?l` dispatch + a public
   `synchronized_update()` accessor). pty.rs side: the frame publish
   condition additionally holds while the mode is set — keep-showing-the-
   last-frame is exactly the spec's presentation semantics — plus a MANDATORY
   timeout guard (~1s, like real terminals): an app Ctrl-C'd between `h` and
   `l` leaves the mode set forever, the same failure class as an unterminated
   image sequence. With the timeout, worst case degrades to today's behavior.
   No wire/viewer/salt impact for either item.

## Phase 1.6 — telemetry fallout, round 2 ✅ (landed 2026-07-10: vt100 `c21661d`, telemetry `6698ebb`)

A real-workload exit report (2026-07-10) flagged five kinds: `CSI c`, `CSI t`,
`ESC \`, `OSC 10`, `OSC 11`. Verified against the vendored source: four of the
five have **no rendering effect** — they are queries, whose replies are the
*real* terminal's job (it sees the teed output and answers into our stdin→PTY
bridge), or pure string syntax. Only the OSC 10/11 *set* form can change what
the screen looks like — that's item 13 in phase 3; everything else is
telemetry noise to silence deliberately.

1. **No-op arms for non-visual sequences, so telemetry stays high-signal.**
   Deliberately-ignored ≠ unhandled: give these real (empty) dispatch arms in
   the vendored crate so they stop landing in the exit report, each with a
   comment naming why ignoring is faithful:
   - `CSI c` / `CSI > c` (Primary/Secondary DA) — identity queries, zero
     render effect; the local terminal answers via the tee (`probe_caps`
     relies on exactly that reply reaching us, not the parser).
   - `ESC \` (ST) — vte ends an OSC/DCS string itself and then reports the
     terminator as a bare esc_dispatch; pure syntax. (These sightings were
     the terminators of the OSC 10/11 queries below.)
   - `CSI t` (XTWINOPS), every op except the already-handled `8` (resize,
     `Callbacks::resize`): the report ops (11/13/14/16/18/19/21) are queries
     answered by the tee, and title push/pop (22/23) renders nothing while the
     mirror has no title feature — item 12 must un-ignore 22/23 if it lands.
   - `OSC 10;?` / `OSC 11;?` (default-color *queries*) — vim/neovim background
     detection; answered by the tee. The **set** form must NOT be silenced:
     it really changes the local screen, and must keep reporting until item 13
     mirrors it.
   While there: record `CSI t`'s params in the telemetry kind (join them like
   `h`/`l`/`m` in `csi_kind`) so a future unknown op is diagnosable straight
   from the exit line instead of reading as a bare `CSI t`.

## Phase 2 — good to have

4. **First-class image placements in the grid** ✅ *(the reason the crate was
   vendored — replaces the corner-sentinel machinery)*. Landed 2026-07-10 as
   vt100 `fddf2de` + PTY `76dac5b`, with one deviation from the plan below:
   instead of an id-only cell field plus a grid-owned id→placement table (whose
   positions every scroll/IL/DL path would have to maintain), each stamped cell
   carries `(id, row_off, col_off)` — the offsets make any surviving cell
   reconstruct the top-left exactly, so no table and no scroll hooks exist at
   all. Remaining follow-ups (each small now that ids exist): per-cell holes on
   the wire (`ImagePlacement` erased-cells key + viewer clip), kitty `a=p`
   (id store) and `a=d` deletes, z-ordering. Original plan: `pty.rs` tracked a
   placed image by writing four Plane-16 PUA sentinel glyphs into the vt100 grid
   at the image's corners and reconstructing the top-left each frame
   (`resolve_images`). It worked, but was an approximation with documented
   ponytails: interior overwrites couldn't punch holes in the overlay, kitty
   `a=p`/`a=d` were unimplementable, and the sentinel scan was a per-frame cost.
   Plan:
   - `crates/vt100`: give cells an optional image id (`Cell` grows a
     `Option<ImageId>`-shaped field; keep it `Copy`-friendly — an id, not the
     payload) and the `Grid` an id→placement table (top-left, cell extent).
     Placement stamps the id into the covered cells; vt100's own
     scroll/reflow/erase then manage lifetime *per cell*, exactly mirroring a
     cell-based sixel terminal's erase semantics — corner sampling becomes
     exact-region tracking for free.
   - `parse.rs`/`pty.rs`: on snapshot, derive each image's surviving cell
     region from the stamped cells (bounding box + which cells are gone);
     delete the sentinel/`drop_mark`/`resolve_images` machinery.
   - Wire: unchanged at first (`i` list on full frames, same placements —
     derivation changes, encoding doesn't). Per-cell erase (holes) needs a
     viewer clip mechanism later — ship region tracking first, holes as a
     follow-up (`ImagePlacement` gains an optional erased-cells key: additive,
     no salt bump).
   - Unlocked follow-ups (each small once ids exist): kitty `a=p` (id store —
     the `t`-then-`p` emitters that currently show nothing), `a=d` deletes,
     z-ordering.
   - Test strategy: port the existing sentinel tests (scroll/clip/evict,
     prompt-overwrite survival, wide-glyph columns) to the new mechanism before
     deleting the old one; they encode the erase-semantics contract.

5. **Modern SGR: undercurl, strikethrough, double underline, underline color.**
   ✅ Landed 2026-07-10 as vt100 `96d1630` + wire/viewer `c3d9d02` (also
   dotted/dashed 4:4/4:5, the 58 colon/colorspace form, and the SSH viewer).
   Wire: `u` carries the kitty style number (1 doubles as the legacy flag —
   old decoders degrade to single underline), `s`/`k` are new optional keys;
   no salt bump. Original rationale: the `sgr` match handled underline as
   exact `[4]`, so `4:3` (undercurl —
   helix and neovim diagnostics emit it) falls through and the underline is
   lost entirely; strikethrough (9/29), double underline (21), and underline
   color (58/59) are absent. Cross-layer: vendored `attrs.rs` storage → wire
   style-run flags (additive keys — old viewers ignore, no salt bump) →
   `viewer.ts` rendering (CSS `text-decoration-style: wavy` etc.). Kitty
   renders all of these locally, so the mirror is visibly wrong in editors
   daily. Gate: only emit wire flags the viewer renders.

6. **DECSCUSR (`CSI Sp q`) cursor shape.** Not tracked; vim's insert-mode beam
   renders as a block in the mirror. Track shape+blink in `Screen`, ship as a
   NEW optional wire key (do not change the existing `p` tri-state — old
   decoders must keep working; additive key, no salt bump), render
   block/beam/underline in the viewer.

## Phase 3 — nice to have

7. **OSC 8 hyperlinks.** Dropped today (no `[b"8", …]` arm). The viewer is a
   browser — real `<a>` links are the most natural rendering this project could
   offer, and kitty supports OSC 8 locally so fidelity permits it. Needs a
   per-cell link id in the vendored crate (pairs naturally with the image-id
   cell field from item 4), a link table on the wire (additive), and anchor
   rendering + `rel="noreferrer"` hygiene in the viewer. Decide explicitly how
   storm mode (canvas) degrades — likely links only in DOM mode.

8. **Damage tracking.** No dirty/damage state exists in the crate; every dirty
   frame does a full-screen `grid_from_screen` scan+alloc and `encode_delta`
   re-compares every row. A dirty-rows bitset maintained by `grid.rs`'s own
   write paths lets both skip clean rows. Perf only — the pipeline holds 30fps
   today (see `zz_measure_wire_cost`), so this earns its keep on large screens
   and single-cell updates (typing). Measure before/after; don't complicate the
   publish path for a win the numbers don't show.

9. **Scrollback.** The README's "not yet" item; not a fight — the vendored
   crate already has a scrollback buffer (`Parser::new`'s third arg, currently
   0) with `set_scrollback` for viewport positioning. The real work is product
   design: wire semantics for history (the diff protocol is screen-shaped),
   viewer UX (scroll = viewport offset messages?), and memory bounds per
   session on the hub. Write a design note before code; this one can balloon.

13. **OSC 10/11 set form: default foreground/background color.** *(the one
    real gap in the 2026-07-10 telemetry batch — see phase 1.6 for the noise
    half)*. `OSC 10;<color>` / `OSC 11;<color>` (plus the `OSC 110`/`111`
    resets) change the terminal's default fg/bg; kitty applies them live, so
    after a theme switcher or an `OSC 11`-emitting TUI runs, the local screen
    repaints and the mirror silently keeps its configured colors — visible
    divergence on every default-colored cell. Cross-layer, the item-5 pattern:
    the vendored `Screen` stores the two overrides (parse at least `#RRGGBB`
    and `rgb:RR/GG/BB`; unparseable values stay unhandled so telemetry keeps
    flagging them), the wire ships them as an additive full-frame key (old
    viewers ignore it → no salt bump), and the viewer maps them onto the
    default-color CSS it already derives from the render config. Gate: only
    emit what the viewer renders, and keep the *query* forms in phase 1.6's
    no-op arms — they must not set anything.

## Phase 4 — maybe one day

10. **Sixel interception via vte's DCS hooks.** vte routes DCS byte-by-byte
    through `hook`/`put`/`unhook` (vt100 implements none) — streaming, no size
    cap, string-cancellation semantics for free. But kitty APC isn't exposed by
    vte at all, and OSC payloads sit in a fixed 1024-byte buffer, so the
    interceptor must stay for kitty + iTerm2 regardless. Moving only sixel
    would mean two mechanisms where today there is one — do this only if vte
    itself is ever swapped/patched (vte is actively maintained; the vendor
    argument does not apply to it).

11. **Resize reflow.** `set_size` truncates/pads rows and clears wrap flags on
    width change; kitty reflows wrapped lines. The mirror diverges from the
    local screen after SIGWINCH until the next repaint — which fullscreen apps
    do immediately, so it self-heals in practice. Real reflow is the hardest
    item on this page for the smallest visible payoff. Documented divergence;
    revisit only if users actually hit it.

12. **Window title in the viewer.** vt100 already tracks OSC 0/2 titles; the
    viewer page title could follow the session's. Trivial-ish (additive wire
    key), just never important. Bundle it with whichever phase-2/3 item next
    touches the wire. If this lands, un-ignore XTWINOPS 22/23 (title push/pop,
    no-op'd in phase 1.6) — with a rendered title they become state changes.

## Sequencing note

Items 4 and 7 both hang a small per-cell tag off the vendored grid. Item 4
landed first and set the pattern: an `Option`-of-`Copy`-struct field on `Cell`
(`ImageCell`), cleared by the cell's own `set`/`clear`, stamped by a `Screen`
method, read back by a consumer-side scan. OSC 8 (item 7) should be a client of
that pattern — its own `Option<LinkId>` field resolved through a link table —
not a second mechanism.
