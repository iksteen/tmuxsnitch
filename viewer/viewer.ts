// shellglass browser renderer — THE renderer; nothing is painted server-side.
//
// Receives the compact cell-diff stream over SSE and renders it to HTML: run
// coalescing with absolute per-run positioning, SVG-scaled symbol glyphs, the
// xterm-256 palette, and reverse/dim/bold/italic/underline styling. It keeps the
// full cell grid in memory so a line diff only re-renders the affected rows. The
// page arrives with an empty #screen and the first SSE event after the version
// hello is always a full frame, so the initial paint lands one round-trip in.
//
// Compiled to viewer.js (see build.rs) and served at /viewer.js; the page injects
// `window.SHELLGLASS = { events, cfg }` before loading this module.

// ── wire types ────────────────────────────────────────────────────────────────

// A color is null (default), a 0-255 palette index, or an [r,g,b] triple.
export type Color = null | number | [number, number, number];

// Flags arrive as 1 (absent = false); all checks are truthiness-based.
type Flag = 0 | 1 | boolean;

export interface Cell {
  t?: string; // text (grapheme); absent = blank
  f?: Color; // fg
  g?: Color; // bg
  b?: Flag; // bold
  d?: Flag; // dim
  i?: Flag; // italic
  u?: Flag; // underline
  n?: Flag; // inverse
  w?: Flag; // wide (two columns)
}

export type Cur = [number, number] | null;

// A cell's style attributes (everything but the text), keyed like Cell. Flags
// arrive as 1 (absent = false); truthiness checks handle both.
export type Style = Omit<Cell, "t">;

// A text entry: a string is one cell per CODEPOINT (consecutive single-codepoint
// glyphs merged — "foo" is three cells), 0 is a blank cell, and a one-element
// array ["…"] is a single cell holding a multi-codepoint grapheme (combining
// marks), which a merged string could not represent unambiguously.
export type TextEntry = string | number | [string];

// A style run over the block's cell indices: [start, len, style].
export type StyleRun = [number, number, Style];

// Columnar cell block, positional: [text] or [text, style-runs].
export type Block = [TextEntry[]] | [TextEntry[], StyleRun[]];

// A changed line, positional. Two forms by the third element's type:
// [row, left, entries, runs?] — a line span; [row, left, "…", {style}?] — a
// single changed cell (the whole string is that cell's grapheme).
type WireRow =
  | [number, number, TextEntry[]]
  | [number, number, TextEntry[], StyleRun[]]
  | [number, number, string]
  | [number, number, string, Style];

// There is no "t" tag: each message type owns one payload key (d/r/c/l/b/v), and
// apply() dispatches on which is present — `c` FIRST, since the single-cell form
// flattens its style letters (f,g,b,d,i,u,n,w) into the envelope. The cursor is a
// separate `p` key on every diff-family message.
interface FullMsg {
  d: Block[];
  w: number;
  h: number;
  p?: Cur; // cursor [row, col]; absent = hidden
}
// On diff-family messages the cursor is TRI-STATE: absent = unchanged,
// null = became hidden, [row, col] = moved. A cursor-only move drops `r`,
// leaving just { p }.
interface DiffMsg {
  r?: WireRow[];
  p?: Cur;
}
// A uniform span: c is the bare [row, left, "…"] tuple — ONE CELL PER CODEPOINT
// — and the style flattened into the message applies to every cell.
interface CellMsg extends Style {
  c: [number, number, string];
  p?: Cur;
}
// A single changed line: l is the bare [row, left, entries, runs?] tuple.
interface LineMsg {
  l: WireRow;
  p?: Cur;
}

// Materialize text entries + style runs into per-cell objects (the form renderRow
// consumes). for..of on a string iterates CODEPOINTS (unlike split(""), which
// would shred surrogate pairs), matching the encoder's merge rule exactly.
export function decodeCells(text: TextEntry[], runs?: StyleRun[]): Cell[] {
  const cells: Cell[] = [];
  for (const v of text) {
    if (typeof v === "number") cells.push({ t: "" });
    else if (typeof v === "string") for (const ch of v) cells.push({ t: ch });
    else cells.push({ t: v[0] });
  }
  for (const [start, len, st] of runs ?? []) {
    for (let i = start; i < start + len && i < cells.length; i++) {
      cells[i] = { t: cells[i].t, ...st };
    }
  }
  return cells;
}

export function decodeBlock(block: Block): Cell[] {
  return decodeCells(block[0] ?? [], block[1]);
}
interface BannerMsg {
  b: string;
}
// Version hello, first event of every SSE stream: the wire proto and the baked
// viewer.js content tag. If either differs from what this page booted with, the
// server was upgraded under us — reload to fetch the matching page + viewer.js
// (guarded against reload storms).
interface VersionMsg {
  v: number;
  js?: string;
}
type Msg = FullMsg | DiffMsg | CellMsg | LineMsg | BannerMsg | VersionMsg;

export interface Cfg {
  defFg: string; // default fg as #rrggbb (for reverse/dim materialization)
  defBg: string;
  fillFont: string; // base font stack for stretch-fill glyphs
  sym: [number, number, string][]; // [lo, hi, family-stack] symbol_map overrides
}

type RGB = [number, number, number];

// ── config ──────────────────────────────────────────────────────────────────

let cfg: Cfg;
export function setConfig(c: Cfg): void {
  cfg = c;
}

// The wire-protocol version + viewer.js tag this page booted with
// (window.SHELLGLASS.proto / .js).
let proto: number | undefined;
let jsTag: string | undefined;
export function setProto(p: number | undefined, js?: string): void {
  proto = p;
  jsTag = js;
}

// Overridable for tests; guarded so a misbehaving server can't reload-loop us.
export let reloadPage = (): void => {
  try {
    const last = Number(sessionStorage.getItem("sg-reload") ?? 0);
    if (Date.now() - last < 5000) return;
    sessionStorage.setItem("sg-reload", String(Date.now()));
  } catch (e) {
    /* no sessionStorage: still reload, worst case the server keeps kicking us */
  }
  location.reload();
};
export function setReloadPage(f: () => void): void {
  reloadPage = f;
}

// ── color ─────────────────────────────────────────────────────────────────────

const BASE16: RGB[] = [
  [0x00, 0x00, 0x00], [0xcd, 0x00, 0x00], [0x00, 0xcd, 0x00], [0xcd, 0xcd, 0x00],
  [0x00, 0x00, 0xee], [0xcd, 0x00, 0xcd], [0x00, 0xcd, 0xcd], [0xe5, 0xe5, 0xe5],
  [0x7f, 0x7f, 0x7f], [0xff, 0x00, 0x00], [0x00, 0xff, 0x00], [0xff, 0xff, 0x00],
  [0x5c, 0x5c, 0xff], [0xff, 0x00, 0xff], [0x00, 0xff, 0xff], [0xff, 0xff, 0xff],
];

// xterm 256-color palette (port of render.rs:palette).
export function palette(i: number): RGB {
  if (i < 16) return BASE16[i];
  if (i < 232) {
    const n = i - 16;
    const L = [0, 95, 135, 175, 215, 255];
    return [L[Math.floor(n / 36)], L[Math.floor(n / 6) % 6], L[n % 6]];
  }
  const v = 8 + 10 * (i - 232);
  return [v, v, v];
}

function hex(c: RGB): string {
  return "#" + c.map((x) => x.toString(16).padStart(2, "0")).join("");
}

function parseHex(s: string): RGB {
  return [
    parseInt(s.slice(1, 3), 16),
    parseInt(s.slice(3, 5), 16),
    parseInt(s.slice(5, 7), 16),
  ];
}

export function resolveRgb(c: Color | undefined): RGB | null {
  if (c == null) return null;
  if (typeof c === "number") return palette(c);
  return c;
}

// ── cell → CSS (port of render.rs:cell_box_style) ─────────────────────────────

export function cellStyle(cell: Cell, isCursor: boolean): string {
  let fg = resolveRgb(cell.f);
  let bg = resolveRgb(cell.g);
  // Reverse video (inverse XOR cursor) swaps fg/bg, materializing defaults.
  if (!!cell.n !== isCursor) {
    const f = fg ?? parseHex(cfg.defFg);
    const b = bg ?? parseHex(cfg.defBg);
    fg = b;
    bg = f;
  }
  if (cell.d) {
    const f = fg ?? parseHex(cfg.defFg);
    fg = [Math.floor(f[0] / 10) * 6, Math.floor(f[1] / 10) * 6, Math.floor(f[2] / 10) * 6];
  }
  let s = "";
  if (fg) s += `color:${hex(fg)};`;
  if (bg) s += `background:${hex(bg)};`;
  if (cell.b) s += "font-weight:bold;";
  if (cell.i) s += "font-style:italic;";
  if (cell.u) s += "text-decoration:underline;";
  return s;
}

// ── procedural glyph geometry ─────────────────────────────────────────────────
//
// Box-drawing, block, and (phase 2) powerline/legacy-computing glyphs are drawn as
// filled SVG geometry in a normalized viewBox="0 0 1 1" that `preserveAspectRatio
// ="none"` stretches onto the cell — font-independent, exact tiling, uniform line
// thickness. This is what kitty/iTerm2/Windows Terminal do (kitty: decorations.c).
// Everything is FILLED (rects/polys/quarter-annuli); `stroke` is unusable here
// because the anisotropic stretch would make stroke width direction-dependent.

// Cell pixel metrics, measured once at boot (measureMetrics). Deterministic
// defaults keep node tests stable; setMetrics overrides them.
interface Metrics {
  cellW: number;
  cellH: number;
  fontSize: number;
}
let metrics: Metrics = { cellW: 8, cellH: 17, fontSize: 14 };
export function setMetrics(m: Metrics): void {
  metrics = m;
}

// Line weight in CSS px: light scales with font size (never sub-1px), heavy = 2×.
function wpx(weight: number): number {
  const light = Math.max(1, Math.round(metrics.fontSize / 14));
  return weight >= 2 ? 2 * light : light;
}

// Compact number (≤4 decimals, no trailing zeros) — keeps the emitted markup small.
function f(x: number): string {
  return String(Math.round(x * 1e4) / 1e4);
}

// Axis-aligned filled rectangle in unit space.
function rect(x0: number, y0: number, x1: number, y1: number): string {
  return `<rect x="${f(x0)}" y="${f(y0)}" width="${f(x1 - x0)}" height="${f(y1 - y0)}"/>`;
}

// Horizontal band centered on y (pixel-thickness of `weight`), spanning x0..x1.
function hband(y: number, x0: number, x1: number, weight: number): string {
  const h = wpx(weight) / metrics.cellH / 2;
  return rect(x0, y - h, x1, y + h);
}
// Vertical band centered on x, spanning y0..y1.
function vband(x: number, y0: number, y1: number, weight: number): string {
  const w = wpx(weight) / metrics.cellW / 2;
  return rect(x - w, y0, x + w, y1);
}

// Box-drawing "arms" model: up/right/down/left each present with a weight
// (0 none, 1 light, 2 heavy). Each arm is a band from its edge to just past centre;
// arms over-extend to cover the perpendicular bar so junctions/corners close solid.
function arms(u: number, r: number, d: number, l: number): string {
  const eps = wpx(1) / 2; // minimum overlap so collinear arms leave no AA seam
  // half-width of the vertical bar (max of up/down arms), in unit x
  const vw = Math.max(u ? wpx(u) / 2 : 0, d ? wpx(d) / 2 : 0, eps) / metrics.cellW;
  // half-height of the horizontal bar (max of left/right arms), in unit y
  const hh = Math.max(l ? wpx(l) / 2 : 0, r ? wpx(r) / 2 : 0, eps) / metrics.cellH;
  const ov = OVERSHOOT / metrics.cellH;
  let s = "";
  if (u) s += vband(0.5, -ov, 0.5 + hh, u);
  if (d) s += vband(0.5, 0.5 - hh, 1 + ov, d);
  if (l) s += hband(0.5, 0, 0.5 + vw, l);
  if (r) s += hband(0.5, 0.5 - vw, 1, r);
  return s;
}
// CSS-px overshoot past the cell top/bottom for vertical bars, bridging the per-SVG
// crispEdges snapping discrepancy. Tuning knob: bigger = fewer seams, more stub on loose
// glyphs.
const OVERSHOOT = 0.5;

// Packed arm table for U+2500–257F, 4 chars "urdl" per codepoint (0/1/2 weights);
// "0000" = handled elsewhere (dashes/doubles/arcs/diagonals) or no arms.
const ARMS =
  "0101020210102020" + // 2500 ─ ━ │ ┃
  "0000000000000000" + // 2504-2507 dashes
  "0000000000000000" + // 2508-250B dashes
  "0110021001200220" + // 250C ┌┍┎┏
  "0011001200210022" + // 2510 ┐┑┒┓
  "1100120021002200" + // 2514 └┕┖┗
  "1001100220012002" + // 2518 ┘┙┚┛
  "1110121021101120" + // 251C ├┝┞┟
  "2120221012202220" + // 2520 ┠┡┢┣
  "1011101220111021" + // 2524 ┤┥┦┧
  "2021201210222022" + // 2528 ┨┩┪┫
  "0111011202110212" + // 252C ┬┭┮┯
  "0121012202210222" + // 2530 ┰┱┲┳
  "1101110212011202" + // 2534 ┴┵┶┷
  "2101210222012202" + // 2538 ┸┹┺┻
  "1111111212111212" + // 253C ┼┽┾┿
  "2111112121212112" + // 2540 ╀╁╂╃
  "2211112212212212" + // 2544 ╄╅╆╇
  "1222212222212222" + // 2548 ╈╉╊╋
  "0000000000000000" + // 254C-254F dashes
  "0000000000000000" + // 2550-2553 doubles
  "0000000000000000" + // 2554-2557 doubles
  "0000000000000000" + // 2558-255B doubles
  "0000000000000000" + // 255C-255F doubles
  "0000000000000000" + // 2560-2563 doubles
  "0000000000000000" + // 2564-2567 doubles
  "0000000000000000" + // 2568-256B doubles
  "0000000000000000" + // 256C double, 256D-256F arcs
  "0000000000000000" + // 2570 arc, 2571-2573 diagonals
  "0001100001000010" + // 2574 ╴╵╶╷
  "0002200002000020" + // 2578 ╸╹╺╻
  "0201102001022010"; //  257C ╼╽╾╿

// Dashed lines: 2504-250B (triple/quad) and 254C-254F (double).
function dashes(horiz: boolean, n: number, weight: number): string {
  let s = "";
  const seg = 1 / n;
  const dash = seg * 0.6;
  for (let i = 0; i < n; i++) {
    const a = i * seg + (seg - dash) / 2;
    s += horiz ? hband(0.5, a, a + dash, weight) : vband(0.5, a, a + dash, weight);
  }
  return s;
}
function dashGlyph(cp: number): string {
  if (cp <= 0x250b) {
    const k = cp - 0x2504;
    return dashes((k & 3) < 2, k < 4 ? 3 : 4, k & 1 ? 2 : 1);
  }
  const k = cp - 0x254c;
  return dashes(k < 2, 2, k & 1 ? 2 : 1);
}

// Double lines U+2550–256C. Each is a set of light "rails": vertical rails at
// x=0.5±dh (double) or x=0.5 (single), horizontal at y=0.5±dv or 0.5. Present arms
// run full length; the centre hole of ╬ and the notches of corners emerge from the
// rail spacing alone (no per-junction subtraction needed). Per cp: [u,d,l,r,vDbl,hDbl].
const DOUBLES: number[][] = [
  [0, 0, 1, 1, 0, 1], // 2550 ═
  [1, 1, 0, 0, 1, 0], // 2551 ║
  [0, 1, 0, 1, 0, 1], // 2552 ╒
  [0, 1, 0, 1, 1, 0], // 2553 ╓
  [0, 1, 0, 1, 1, 1], // 2554 ╔
  [0, 1, 1, 0, 0, 1], // 2555 ╕
  [0, 1, 1, 0, 1, 0], // 2556 ╖
  [0, 1, 1, 0, 1, 1], // 2557 ╗
  [1, 0, 0, 1, 0, 1], // 2558 ╘
  [1, 0, 0, 1, 1, 0], // 2559 ╙
  [1, 0, 0, 1, 1, 1], // 255A ╚
  [1, 0, 1, 0, 0, 1], // 255B ╛
  [1, 0, 1, 0, 1, 0], // 255C ╜
  [1, 0, 1, 0, 1, 1], // 255D ╝
  [1, 1, 0, 1, 0, 1], // 255E ╞
  [1, 1, 0, 1, 1, 0], // 255F ╟
  [1, 1, 0, 1, 1, 1], // 2560 ╠
  [1, 1, 1, 0, 0, 1], // 2561 ╡
  [1, 1, 1, 0, 1, 0], // 2562 ╢
  [1, 1, 1, 0, 1, 1], // 2563 ╣
  [0, 1, 1, 1, 0, 1], // 2564 ╤
  [0, 1, 1, 1, 1, 0], // 2565 ╥
  [0, 1, 1, 1, 1, 1], // 2566 ╦
  [1, 0, 1, 1, 0, 1], // 2567 ╧
  [1, 0, 1, 1, 1, 0], // 2568 ╨
  [1, 0, 1, 1, 1, 1], // 2569 ╩
  [1, 1, 1, 1, 0, 1], // 256A ╪
  [1, 1, 1, 1, 1, 0], // 256B ╫
  [1, 1, 1, 1, 1, 1], // 256C ╬
];
function doubleGlyph(cp: number): string {
  const [u, d, l, r, vd, hd] = DOUBLES[cp - 0x2550];
  const hw = wpx(1) / metrics.cellW / 2;
  const hh = wpx(1) / metrics.cellH / 2;
  const dh = wpx(1) / metrics.cellW; // vertical-rail offset
  const dv = wpx(1) / metrics.cellH; // horizontal-rail offset
  const maxDv = hd ? dv : 0;
  const maxDh = vd ? dh : 0;
  const ov = OVERSHOOT / metrics.cellH; // bridge stacked-row seams (see arms())
  let s = "";
  if (u || d) {
    for (const x of vd ? [0.5 - dh, 0.5 + dh] : [0.5]) {
      s += vband(x, u ? -ov : 0.5 - maxDv - hh, d ? 1 + ov : 0.5 + maxDv + hh, 1);
    }
  }
  if (l || r) {
    for (const y of hd ? [0.5 - dv, 0.5 + dv] : [0.5]) {
      s += hband(y, l ? 0 : 0.5 - maxDh - hw, r ? 1 : 0.5 + maxDh + hw, 1);
    }
  }
  return s;
}

// Rounded corners ╭╮╯╰: a filled quarter-annulus (radius 0.5) centred on a cell
// corner, joining the two adjacent edge midpoints.
function arc(cx: number, cy: number): string {
  const tx = wpx(1) / metrics.cellW / 2;
  const ty = wpx(1) / metrics.cellH / 2;
  const sx = cx === 1 ? -1 : 1; // outward-x at endpoint A=(0.5,cy)
  const sy = cy === 1 ? -1 : 1; // outward-y at endpoint B=(cx,0.5)
  const aOut = 0.5 + sx * tx;
  const aIn = 0.5 - sx * tx;
  const bOut = 0.5 + sy * ty;
  const bIn = 0.5 - sy * ty;
  const sweep = sx * sy < 0 ? 0 : 1;
  return (
    `<path d="M ${f(aOut)} ${f(cy)} A ${f(0.5 + tx)} ${f(0.5 + ty)} 0 0 ${sweep} ${f(cx)} ${f(bOut)} ` +
    `L ${f(cx)} ${f(bIn)} A ${f(0.5 - tx)} ${f(0.5 - ty)} 0 0 ${1 - sweep} ${f(aIn)} ${f(cy)} Z"/>`
  );
}
function arcGlyph(cp: number): string {
  const c = [
    [1, 1],
    [0, 1],
    [0, 0],
    [1, 0],
  ][cp - 0x256d];
  return arc(c[0], c[1]);
}

// Diagonals ╱╲╳: a filled parallelogram along the diagonal, perpendicular width
// computed in pixel space so it looks like a line of the right thickness.
function diag(x0: number, y0: number, x1: number, y1: number): string {
  const dxp = (x1 - x0) * metrics.cellW;
  const dyp = (y1 - y0) * metrics.cellH;
  const len = Math.hypot(dxp, dyp);
  const t = wpx(1) / 2;
  const ux = (-dyp / len) * t / metrics.cellW; // perpendicular offset in unit space
  const uy = (dxp / len) * t / metrics.cellH;
  return (
    `<path d="M ${f(x0 + ux)} ${f(y0 + uy)} L ${f(x1 + ux)} ${f(y1 + uy)} ` +
    `L ${f(x1 - ux)} ${f(y1 - uy)} L ${f(x0 - ux)} ${f(y0 - uy)} Z"/>`
  );
}
function diagGlyph(cp: number): string {
  const up = cp !== 0x2572 ? diag(0, 1, 1, 0) : ""; // ╱ (also in ╳)
  const down = cp !== 0x2571 ? diag(0, 0, 1, 1) : ""; // ╲ (also in ╳)
  return up + down;
}

// Block elements U+2580–259F: solid rectangles (fractions from cp arithmetic),
// shades as alpha fill, quadrants from a 4-bit mask.
const QUADRANTS = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14]; // 2596-259F: bit0 TL,1 TR,2 BL,3 BR
function blockElement(cp: number): string {
  if (cp === 0x2580) return rect(0, 0, 1, 0.5); // ▀ upper half
  if (cp >= 0x2581 && cp <= 0x2588) return rect(0, 1 - (cp - 0x2580) / 8, 1, 1); // ▁-█ lower
  if (cp >= 0x2589 && cp <= 0x258f) return rect(0, 0, (0x2590 - cp) / 8, 1); // ▉-▏ left
  if (cp === 0x2590) return rect(0.5, 0, 1, 1); // ▐ right half
  if (cp <= 0x2593) {
    const op = (cp - 0x2590) / 4; // ░▒▓ → .25/.5/.75
    return `<rect x="0" y="0" width="1" height="1" fill-opacity="${op}"/>`;
  }
  if (cp === 0x2594) return rect(0, 0, 1, 0.125); // ▔ upper eighth
  if (cp === 0x2595) return rect(0.875, 0, 1, 1); // ▕ right eighth
  const m = QUADRANTS[cp - 0x2596]; // 2596-259F
  let s = "";
  if (m & 1) s += rect(0, 0, 0.5, 0.5);
  if (m & 2) s += rect(0.5, 0, 1, 0.5);
  if (m & 4) s += rect(0, 0.5, 0.5, 1);
  if (m & 8) s += rect(0.5, 0.5, 1, 1);
  return s;
}

function boxDrawing(cp: number): string {
  if ((cp >= 0x2504 && cp <= 0x250b) || (cp >= 0x254c && cp <= 0x254f)) return dashGlyph(cp);
  if (cp >= 0x2550 && cp <= 0x256c) return doubleGlyph(cp);
  if (cp >= 0x256d && cp <= 0x2570) return arcGlyph(cp);
  if (cp >= 0x2571 && cp <= 0x2573) return diagGlyph(cp);
  const o = (cp - 0x2500) * 4;
  return arms(+ARMS[o], +ARMS[o + 1], +ARMS[o + 2], +ARMS[o + 3]);
}

// Inner SVG geometry for a codepoint, or null if we don't synthesize it (falls back
// to the font-stretch path). Phase 1: box drawing + block elements.
export function glyphGeometry(cp: number): string | null {
  if (cp >= 0x2500 && cp <= 0x257f) return boxDrawing(cp);
  if (cp >= 0x2580 && cp <= 0x259f) return blockElement(cp);
  return null;
}

// ── symbol / fill glyphs (port of render.rs:is_fill_glyph + svg_font) ──────────

export function isFillGlyph(cp: number): boolean {
  return (
    (cp >= 0xe0b0 && cp <= 0xe0d4) || // powerline separators
    (cp >= 0x2500 && cp <= 0x259f) || // box drawing + block elements
    (cp >= 0x1fb00 && cp <= 0x1fbaf) // legacy computing
  );
}

// A glyph uniform along x, so a run of it renders as ONE stretched span instead of N
// per-cell boxes — killing the sub-pixel seams that dash a horizontal divider at
// fractional zoom. Solid horizontal strips only, plus shades (now x-uniform alpha rects
// via geometry — safe to stretch). Dashed/side-blocks would smear across a run, so they
// stay per-cell.
export function isMergeableFill(cp: number): boolean {
  return (
    cp === 0x2500 || // ─
    cp === 0x2501 || // ━
    cp === 0x2550 || // ═
    cp === 0x2580 || // ▀ upper half
    cp === 0x2588 || // █ full block
    (cp >= 0x2581 && cp <= 0x2587) || // ▁▂▃▄▅▆▇ lower strips
    (cp >= 0x2591 && cp <= 0x2593) || // ░▒▓ shades (alpha rects)
    cp === 0x2594 // ▔ upper strip
  );
}

function symbolFamily(cp: number): string | null {
  for (const [lo, hi, fam] of cfg.sym) {
    if (cp >= lo && cp <= hi) return fam;
  }
  return null;
}

// The font stack to render `cell` as a scaled SVG glyph, or null for plain text.
function svgFont(cell: Cell): string | null {
  const t = cell.t ?? "";
  if (!t) return null;
  const cp = t.codePointAt(0)!;
  const fam = symbolFamily(cp);
  if (fam) return fam;
  return isFillGlyph(cp) ? cfg.fillFont : null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Emit one SVG symbol span (already-escaped glyph, precomputed boxStyle) covering w
// columns. Shared by single symbol cells and merged fill runs — for a merged run, w
// is the run's total width and the one glyph stretches seamlessly across it (no
// per-cell box boundaries to gap at fractional zoom). Mirrors render.rs.
function symbolSpan(
  col: number,
  w: number,
  boxStyle: string,
  font: string,
  glyph: string,
  first: number,
): string {
  const fill = isFillGlyph(first);
  const par = fill ? "none" : "xMidYMid meet";
  // Fill glyphs span the whole box so lines tile; a monospace advance is only ~0.6em,
  // so a bare none-stretch under-fills and horizontals dash. textLength forces the
  // glyph to the viewBox width; none then maps it onto the full box.
  const stretch = fill ? ' textLength="14" lengthAdjust="spacingAndGlyphs"' : "";
  return (
    `<span class="run" style="left:${col}ch;width:${w}ch;${boxStyle}">` +
    `<svg viewBox="0 0 14 14" preserveAspectRatio="${par}" style="display:block;width:100%;height:100%">` +
    `<text x="0" y="12" font-family="${font}" font-size="14" fill="currentColor"${stretch}>${glyph}</text></svg></span>`
  );
}

function symbolCell(cell: Cell, isCursor: boolean, col: number, w: number, font: string): string {
  const boxStyle = cellStyle(cell, isCursor);
  const t = cell.t ?? " ";
  return symbolSpan(col, w, boxStyle, font, esc(t), t.codePointAt(0) ?? 0x20);
}

// Emit one procedural-geometry span covering w columns. The unit viewBox is stretched
// onto the cell(s) with preserveAspectRatio="none"; a merged run stretches the single
// glyph across the whole width, so tiling lines have no per-cell seams. `fill=
// "currentColor"` lets the shapes inherit the cell's fg (cursor/inverse/dim included).
function geomSpan(col: number, w: number, boxStyle: string, geom: string): string {
  // Axis-aligned geometry (box lines, blocks, doubles, dashes — all <rect>) renders with
  // anti-aliasing OFF so lines snap to whole opaque pixels: crisp and, crucially, identical
  // every row, so a stacked vertical divider has no fractional-pixel seams OR beading (the
  // terminal-correct look). Curved/diagonal glyphs (<path>: arcs, ╱╲) keep anti-aliasing.
  const crisp = geom.includes("<path") ? "" : ' shape-rendering="crispEdges"';
  // overflow:visible (span overrides .run's clip; svg overrides its viewport) lets the
  // vertical overshoot paint into the neighbouring rows where it overlaps their bars.
  // .screen still clips the whole grid.
  return (
    `<span class="run" style="left:${col}ch;width:${w}ch;overflow:visible;${boxStyle}">` +
    `<svg viewBox="0 0 1 1" preserveAspectRatio="none" fill="currentColor" overflow="visible"${crisp} style="display:block;width:100%;height:100%">${geom}</svg></span>`
  );
}

// ── row rendering (port of render.rs:render_row) ──────────────────────────────

// Render one row's cells to inner HTML. `cursorCol` is the cursor column, or -1.
interface FillRun {
  col: number;
  width: number;
  t: string; // raw glyph, for run-continuation comparison
  glyph: string; // escaped, for emission
  style: string;
  font: string; // font stack for the stretch path ("" when geom is set)
  first: number;
  geom: string | null; // procedural geometry, or null for the font-stretch path
}

export function renderRow(cells: Cell[], cursorCol: number): string {
  let out = "";
  let col = 0;
  let runStyle: string | null = null;
  let runCol = 0;
  let cols = 0;
  let text = "";
  const flushText = () => {
    if (text.length === 0) return;
    out += `<span class="run" style="left:${runCol}ch;width:${cols}ch;${runStyle ?? ""}">${text}</span>`;
    text = "";
  };
  // A run of the same mergeable fill glyph, emitted as one stretched span.
  let fill: FillRun | null = null;
  const flushFill = () => {
    if (fill) {
      out += fill.geom
        ? geomSpan(fill.col, fill.width, fill.style, fill.geom)
        : symbolSpan(fill.col, fill.width, fill.style, fill.font, fill.glyph, fill.first);
      fill = null;
    }
  };
  for (const cell of cells) {
    const isCursor = col === cursorCol;
    const w = cell.w ? 2 : 1;
    const t = cell.t ?? "";
    const first = t ? t.codePointAt(0)! : 0x20;
    // Geometry beats symbol_map for standard Unicode ranges (kitty parity); symbol_map
    // beats geometry only in the PUA, where a user mapping powerline glyphs to a Nerd
    // Font was deliberate. Uncovered codepoints fall through to the font-stretch path.
    const geom =
      t && !(first >= 0xe000 && first <= 0xf8ff && symbolFamily(first))
        ? glyphGeometry(first)
        : null;
    const font = geom ? null : svgFont(cell);
    if (geom || font) {
      flushText();
      runStyle = null;
      cols = 0;
      if (isMergeableFill(first)) {
        const style = cellStyle(cell, isCursor);
        if (
          fill &&
          fill.t === t &&
          fill.style === style &&
          fill.font === (font ?? "") &&
          fill.geom === geom
        ) {
          fill.width += w;
        } else {
          flushFill();
          fill = { col, width: w, t, glyph: esc(t || " "), style, font: font ?? "", first, geom };
        }
      } else {
        flushFill();
        out += geom
          ? geomSpan(col, w, cellStyle(cell, isCursor), geom)
          : symbolCell(cell, isCursor, col, w, font!);
      }
    } else {
      flushFill();
      const style = cellStyle(cell, isCursor);
      if (runStyle !== style) {
        flushText();
        runStyle = style;
        cols = 0;
      }
      if (cols === 0) runCol = col;
      text += esc(cell.t && cell.t.length ? cell.t : " ");
      cols += w;
    }
    col += w;
  }
  flushText();
  flushFill();
  return out;
}

function cursorCol(cur: Cur, row: number): number {
  return cur && cur[0] === row ? cur[1] : -1;
}

// ── screen state + message application ────────────────────────────────────────

interface ScreenState {
  cells: Cell[][];
  cur: Cur;
  rowEls: HTMLElement[];
}

let screen: ScreenState = { cells: [], cur: null, rowEls: [] };
let screenEl: HTMLElement;

// Update the screen's cell buffer + cursor from decoded line patches, returning
// the rows to re-render (changed lines plus the old and new cursor rows). The
// cursor is tri-state: undefined = unchanged (leave it, dirty nothing extra),
// null = hidden, [row, col] = moved. DOM-free, so it's unit-tested.
export function patchCells(
  state: { cells: Cell[][]; cur: Cur },
  dp: { cur: Cur | undefined; rows: { r: number; l: number; cells: Cell[] }[] },
): Set<number> {
  const dirty = new Set<number>();
  if (dp.cur !== undefined) {
    if (state.cur) dirty.add(state.cur[0]);
    if (dp.cur) dirty.add(dp.cur[0]);
    state.cur = dp.cur;
  }
  for (const patch of dp.rows) {
    let row = state.cells[patch.r];
    if (!row) {
      row = [];
      state.cells[patch.r] = row;
    }
    for (let dx = 0; dx < patch.cells.length; dx++) {
      const i = patch.l + dx;
      // Pad a growing row with canonical blanks — bare assignment past the end
      // would leave holes (undefined cells) that renderRow can't iterate.
      while (row.length < i) row.push({ t: " " });
      row[i] = patch.cells[dx];
    }
    dirty.add(patch.r);
  }
  return dirty;
}

function applyFull(m: FullMsg): void {
  const cur = m.p ?? null;
  const rows = m.d.map(decodeBlock);
  let html = `<div class="screen" style="width:${m.w}ch;height:calc(${m.h} * var(--lh));">`;
  for (let r = 0; r < rows.length; r++) {
    html += `<div class="row">${renderRow(rows[r], cursorCol(cur, r))}</div>`;
  }
  html += "</div>";
  screenEl.innerHTML = html;

  const screenDiv = screenEl.firstElementChild!;
  screen = {
    cells: rows,
    cur,
    rowEls: Array.from(screenDiv.children) as HTMLElement[],
  };
}

function decodeRow([r, l, text, style]: WireRow): { r: number; l: number; cells: Cell[] } {
  if (typeof text === "string") {
    // Bare string = one cell per codepoint; the single style covers all.
    const st = style as Style | undefined;
    const cells: Cell[] = [];
    for (const ch of text) cells.push(st ? { t: ch, ...st } : { t: ch });
    return { r, l, cells };
  }
  return { r, l, cells: decodeCells(text, style as StyleRun[] | undefined) };
}

// `m.c` passes through as-is: undefined = cursor unchanged, null = hidden.
function applyPatches(cur: Cur | undefined, rows: { r: number; l: number; cells: Cell[] }[]): void {
  const dirty = patchCells(screen, { cur, rows });
  for (const r of dirty) {
    const el = screen.rowEls[r];
    if (!el) continue;
    el.innerHTML = renderRow(screen.cells[r] ?? [], cursorCol(screen.cur, r));
  }
}

function applyDiff(m: DiffMsg): void {
  applyPatches(m.p, (m.r ?? []).map(decodeRow));
}

function applyCell(m: CellMsg): void {
  const { c: r, p: _p, ...style } = m;
  const styled = Object.keys(style).length > 0;
  const cells: Cell[] = [];
  for (const ch of r[2]) cells.push(styled ? { t: ch, ...style } : { t: ch });
  applyPatches(m.p, [{ r: r[0], l: r[1], cells }]);
}

function applyLine(m: LineMsg): void {
  applyPatches(m.p, [decodeRow(m.l)]);
}

function applyBanner(m: BannerMsg): void {
  screenEl.innerHTML = m.b;
  screen = { cells: [], cur: null, rowEls: [] };
}

// Tag-free dispatch on which payload key is present. `c` (cell) MUST come first —
// its flattened style letters (b/d/w) would otherwise read as banner/full/wide.
// A message with only `p` is a cursor-only diff.
export function apply(m: Msg): void {
  if ("v" in m) {
    const wireChanged = proto !== undefined && m.v !== proto;
    const jsChanged = jsTag !== undefined && m.js !== undefined && m.js !== jsTag;
    if (wireChanged || jsChanged) reloadPage();
    return;
  }
  if ("c" in m) applyCell(m);
  else if ("l" in m) applyLine(m);
  else if ("d" in m) applyFull(m);
  else if ("b" in m) applyBanner(m);
  else applyDiff(m); // { r?, p? } — includes cursor-only { p }
}

// EventSource only auto-retries network blips (readyState CONNECTING); on an HTTP
// error — e.g. the hub restarted and 404s the session until its client
// re-registers — it CLOSEs permanently and the page would go dead. Rebuild it on
// CLOSED with a fixed retry; the server sends a full frame on every (re)connect,
// so no client state needs resetting. The last screen stays frozen meanwhile.
// ponytail: fixed 2s retry, no backoff — it's one idle HTTP request per tick.
function connect(events: string): void {
  const es = new EventSource(events);
  es.onmessage = (e) => apply(JSON.parse(e.data) as Msg);
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      setTimeout(() => connect(events), 2000);
    }
  };
}

// Measure cell pixel geometry off the live #screen so procedural glyphs get exact
// per-axis thickness: cellH from --lh, fontSize from computed style, cellW from a
// 100-char probe (font-dependent; the probe amortizes rounding).
function measureMetrics(): void {
  const cs = getComputedStyle(screenEl);
  const cellH = parseFloat(cs.getPropertyValue("--lh")) || 17;
  const fontSize = parseFloat(cs.fontSize) || 14;
  const probe = document.createElement("span");
  probe.textContent = "0".repeat(100);
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
  screenEl.appendChild(probe);
  const cellW = probe.getBoundingClientRect().width / 100 || 8;
  probe.remove();
  setMetrics({ cellW, cellH, fontSize });
}

function main(): void {
  const boot = (
    window as unknown as { SHELLGLASS: { events: string; cfg: Cfg; proto?: number; js?: string } }
  ).SHELLGLASS;
  setConfig(boot.cfg);
  setProto(boot.proto, boot.js);
  screenEl = document.getElementById("screen")!;
  measureMetrics();
  // A served webfont loads async and can shift cellW after boot; re-measure and, if it
  // moved enough to matter, repaint the current screen with corrected geometry.
  document.fonts?.ready.then(() => {
    const before = metrics.cellW;
    measureMetrics();
    if (Math.abs(metrics.cellW - before) / before > 0.03) {
      for (let r = 0; r < screen.rowEls.length; r++) {
        screen.rowEls[r].innerHTML = renderRow(screen.cells[r] ?? [], cursorCol(screen.cur, r));
      }
    }
  });
  connect(boot.events);
}

// Only bootstrap in the browser; importing this module in Node (tests) is inert.
if (typeof document !== "undefined" && (window as unknown as { SHELLGLASS?: unknown }).SHELLGLASS) {
  main();
}
