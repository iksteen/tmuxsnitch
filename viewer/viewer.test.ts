// Unit tests for the browser renderer's pure logic (no DOM needed). Run with
// `node --test` — Node strips the TypeScript types on import.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  palette,
  resolveRgb,
  cellStyle,
  isFillGlyph,
  glyphGeometry,
  setMetrics,
  renderRow,
  patchCells,
  decodeBlock,
  setConfig,
  setProto,
  setReloadPage,
  apply,
  type Cfg,
} from "./viewer.ts";

const CFG: Cfg = {
  defFg: "#d0d0d0",
  defBg: "#000000",
  fillFont: "monospace",
  sym: [],
};
setConfig(CFG);

// Pin cell metrics so procedural-geometry coordinates are deterministic. cellW≠cellH
// exercises the per-axis thickness (1px is 0.125 in x, 0.0625 in y).
setMetrics({ cellW: 8, cellH: 16, fontSize: 14 });

test("version hello reloads on wire or js mismatch, not on match", () => {
  let reloads = 0;
  setReloadPage(() => {
    reloads += 1;
  });
  setProto(3, "aabbcc");
  apply({ v: 3, js: "aabbcc" } as never);
  assert.equal(reloads, 0, "matching hello is inert");
  apply({ v: 4, js: "aabbcc" } as never);
  assert.equal(reloads, 1, "wire bump reloads");
  apply({ v: 3, js: "ddeeff" } as never);
  assert.equal(reloads, 2, "viewer.js change reloads");
  // A page without boot versions (older HTML) never self-reloads.
  setProto(undefined, undefined);
  apply({ v: 9, js: "zz" } as never);
  assert.equal(reloads, 2);
});

test("palette matches the xterm-256 layout", () => {
  assert.deepEqual(palette(1), [0xcd, 0x00, 0x00]); // base red
  assert.deepEqual(palette(15), [0xff, 0xff, 0xff]); // bright white
  assert.deepEqual(palette(16), [0, 0, 0]); // cube origin
  assert.deepEqual(palette(231), [255, 255, 255]); // cube corner
  assert.deepEqual(palette(232), [8, 8, 8]); // grayscale start
  assert.deepEqual(palette(255), [238, 238, 238]); // grayscale end
});

test("resolveRgb handles the three color forms", () => {
  assert.equal(resolveRgb(null), null);
  assert.equal(resolveRgb(undefined), null);
  assert.deepEqual(resolveRgb(9), [0xff, 0, 0]); // index → palette
  assert.deepEqual(resolveRgb([1, 2, 3]), [1, 2, 3]); // rgb passthrough
});

test("cellStyle emits colors, weight, and reverse video", () => {
  assert.equal(cellStyle({ f: 1, b: true }, false), "color:#cd0000;font-weight:bold;");
  // Inverse on an otherwise-default cell swaps in the default fg/bg.
  assert.equal(cellStyle({ n: true }, false), "color:#000000;background:#d0d0d0;");
  // The cursor reverses too; inverse XOR cursor cancels back to normal.
  assert.equal(cellStyle({ n: true }, true), "");
  assert.equal(cellStyle({}, true), "color:#000000;background:#d0d0d0;");
});

test("cellStyle dim matches the Rust floor formula, italic/underline emit", () => {
  // Rust: f/10*6 (integer division) — default fg 0xd0=208 → 20*6 = 120 = 0x78.
  assert.equal(cellStyle({ d: true }, false), "color:#787878;");
  // On a palette color: bright red 255 → 25*6 = 150 = 0x96.
  assert.equal(cellStyle({ f: 9, d: true }, false), "color:#960000;");
  assert.equal(
    cellStyle({ i: true, u: true }, false),
    "font-style:italic;text-decoration:underline;",
  );
});

test("renderRow coalesces same-style cells into one positioned run", () => {
  const html = renderRow([{ t: "a" }, { t: "b" }, { t: "c" }], -1);
  assert.equal(html, '<span class="run" style="left:0ch;width:3ch;">abc</span>');
});

test("renderRow positions each run absolutely by column", () => {
  // A styled middle cell splits the row into three runs, each at its own column.
  const html = renderRow([{ t: "a" }, { t: "b", b: true }, { t: "c" }], -1);
  assert.match(html, /left:0ch;width:1ch;">a</);
  assert.match(html, /left:1ch;width:1ch;font-weight:bold;">b</);
  assert.match(html, /left:2ch;width:1ch;">c</);
});

test("renderRow marks the cursor cell with reverse video", () => {
  const html = renderRow([{ t: "x" }], 0);
  assert.match(html, /color:#000000;background:#d0d0d0;/);
});

test("wide cells advance two columns", () => {
  // Same-style cells coalesce (as render_row does), so the wide glyph shows up as
  // extra width, not a separate run: 世(2) + a(1) = width 3.
  assert.equal(
    renderRow([{ t: "世", w: true }, { t: "a" }], -1),
    '<span class="run" style="left:0ch;width:3ch;">世a</span>',
  );
  // A style break after the wide glyph reveals the column advance: the next run
  // starts at column 2, not 1.
  const split = renderRow([{ t: "世", w: true }, { t: "a", b: true }], -1);
  assert.match(split, /left:0ch;width:2ch;">世</);
  assert.match(split, /left:2ch;width:1ch;font-weight:bold;">a</);
});

test("box-drawing glyphs render as procedural geometry, not font text", () => {
  const box = renderRow([{ t: "│" }], -1);
  assert.match(box, /<svg /);
  assert.match(box, /viewBox="0 0 1 1"/);
  assert.match(box, /preserveAspectRatio="none"/);
  assert.match(box, /<rect /); // filled geometry
  assert.doesNotMatch(box, /<text/); // not a stretched font glyph
  const plain = renderRow([{ t: "a" }], -1);
  assert.doesNotMatch(plain, /<svg/);
});

test("uncovered fill glyphs keep the font-stretch fallback", () => {
  // A powerline separator (PUA) has no synthesized geometry yet — still a stretched
  // font glyph with the textLength fill.
  const cp = 0xe0b0;
  assert.ok(isFillGlyph(cp));
  assert.equal(glyphGeometry(cp), null);
  const pl = renderRow([{ t: String.fromCodePoint(cp) }], -1);
  assert.match(pl, /textLength="14" lengthAdjust="spacingAndGlyphs"/);
});

test("runs of x-uniform glyphs merge (lines AND shades); distinct don't", () => {
  const div = renderRow([{ t: "─" }, { t: "─" }, { t: "─" }, { t: "─" }, { t: "─" }], -1);
  assert.equal((div.match(/<svg /g) ?? []).length, 1, "divider run not merged");
  assert.match(div, /left:0ch;width:5ch;/);
  // Shades now merge too — as alpha rects they're x-uniform.
  const shade = renderRow([{ t: "░" }, { t: "░" }, { t: "░" }], -1);
  assert.equal((shade.match(/<svg /g) ?? []).length, 1, "shade run not merged");
  assert.match(shade, /left:0ch;width:3ch;/);
  // Distinct adjacent glyphs don't merge.
  const mixed = renderRow([{ t: "─" }, { t: "┼" }, { t: "─" }], -1);
  assert.equal((mixed.match(/<svg /g) ?? []).length, 3, "distinct glyphs merged");
  // The cursor cell's style key differs, so it splits a merged run.
  const cur = renderRow([{ t: "─" }, { t: "─" }, { t: "─" }], 1);
  assert.equal((cur.match(/<svg /g) ?? []).length, 3, "cursor did not split run");
});

test("glyphGeometry covers all of U+2500–259F", () => {
  for (let cp = 0x2500; cp <= 0x259f; cp++) {
    assert.ok(glyphGeometry(cp), `no geometry for U+${cp.toString(16)}`);
  }
  // Just outside the range: nothing synthesized.
  assert.equal(glyphGeometry(0x24ff), null);
  assert.equal(glyphGeometry(0x25a0), null);
});

test("line thickness is per-axis (1px both ways under 8×16 cells)", () => {
  // ─ is a horizontal band: 1px tall = 0.0625 in y. │ is 1px wide = 0.125 in x.
  assert.match(glyphGeometry(0x2500)!, /height="0.0625"/); // ─
  assert.match(glyphGeometry(0x2502)!, /width="0.125"/); // │
  // ━ heavy horizontal is 2px = 0.125 tall.
  assert.match(glyphGeometry(0x2501)!, /height="0.125"/); // ━
});

test("box junctions, doubles, dashes, arcs, diagonals", () => {
  // ┼ light cross: four arms → four rects.
  assert.equal((glyphGeometry(0x253c)!.match(/<rect /g) ?? []).length, 4);
  // ═ / ║ doubles: two parallel full-length rails.
  assert.equal((glyphGeometry(0x2550)!.match(/<rect /g) ?? []).length, 2); // ═
  assert.equal((glyphGeometry(0x2551)!.match(/<rect /g) ?? []).length, 2); // ║
  // ╬ full double cross: four rails (centre hole emerges from spacing).
  assert.equal((glyphGeometry(0x256c)!.match(/<rect /g) ?? []).length, 4);
  // ┄ triple-dash vs ┈ quad-dash: different dash counts.
  assert.equal((glyphGeometry(0x2504)!.match(/<rect /g) ?? []).length, 3);
  assert.equal((glyphGeometry(0x2508)!.match(/<rect /g) ?? []).length, 4);
  // ╭ rounded corner: an elliptical arc command, no rect.
  assert.match(glyphGeometry(0x256d)!, /<path d="M[^"]* A /);
  // ╱ diagonal: a filled polygon, no rect.
  const diag = glyphGeometry(0x2571)!;
  assert.match(diag, /<path d="M/);
  assert.doesNotMatch(diag, /<rect/);
});

test("axis-aligned geometry disables anti-aliasing; curves keep it", () => {
  // Box lines/blocks snap to whole pixels (crispEdges) so a stacked vertical divider is
  // identical every row — no fractional-pixel seams or beading.
  assert.match(renderRow([{ t: "│" }], -1), /<svg[^>]*shape-rendering="crispEdges"/);
  assert.match(renderRow([{ t: "█" }], -1), /<svg[^>]*shape-rendering="crispEdges"/);
  // Arcs and diagonals (<path>) must NOT be crisped, or they'd stairstep.
  assert.doesNotMatch(renderRow([{ t: "╭" }], -1), /crispEdges/);
  assert.doesNotMatch(renderRow([{ t: "╱" }], -1), /crispEdges/);
});

test("vertical bars overshoot + geometry span is unclipped (bridge row seams)", () => {
  // │ up arm overshoots above y=0 (negative), so with crispEdges adjacent rows' bars
  // overlap into a continuous opaque divider instead of leaving per-SVG snapping gaps.
  const v = glyphGeometry(0x2502)!; // │
  assert.match(v, /y="-/, "up arm does not overshoot");
  const down = [...v.matchAll(/y="([-0-9.]+)" width="[-0-9.]+" height="([-0-9.]+)"/g)];
  assert.ok(down.some(([, y, h]) => Number(y) + Number(h) > 1), "down arm does not overshoot");
  // The span and svg must not clip the overshoot.
  const span = renderRow([{ t: "│" }], -1);
  assert.match(span, /class="run" style="[^"]*overflow:visible/);
  assert.match(span, /<svg[^>]*overflow="visible"/);
  // A pure horizontal (─) doesn't overshoot — its extent scales with merged runs.
  assert.doesNotMatch(glyphGeometry(0x2500)!, /y="-/);
});

test("block elements: eighths, shades, quadrants", () => {
  // ▁ lower eighth: bottom 1/8 strip.
  assert.match(glyphGeometry(0x2581)!, /y="0.875"[^/]*height="0.125"/);
  // ░ light shade: 25% alpha fill.
  assert.match(glyphGeometry(0x2591)!, /fill-opacity="0.25"/);
  // ▚ (upper-left + lower-right quadrants): two rects.
  assert.equal((glyphGeometry(0x259a)!.match(/<rect /g) ?? []).length, 2);
});

test("geometry beats symbol_map on standard ranges; cell fg via currentColor", () => {
  setConfig({ ...CFG, sym: [[0x2500, 0x2500, "'Some Nerd Font',monospace"]] });
  const box = renderRow([{ t: "─" }], -1);
  assert.match(box, /<rect /); // geometry wins
  assert.doesNotMatch(box, /Some Nerd Font/); // symbol_map ignored here
  setConfig(CFG);
});

test("thickness scales with font size", () => {
  setMetrics({ cellW: 8, cellH: 16, fontSize: 28 }); // light = round(28/14) = 2px
  assert.match(glyphGeometry(0x2500)!, /height="0.125"/); // ─ now 2px = 0.125 tall
  setMetrics({ cellW: 8, cellH: 16, fontSize: 14 }); // restore
});

test("patchCells writes line patches and reports dirty rows", () => {
  const state = { cells: [[{ t: "a" }, { t: "b" }]], cur: null as [number, number] | null };
  const dirty = patchCells(state, {
    cur: [0, 1],
    rows: [{ r: 0, l: 1, cells: [{ t: "X" }] }],
  });
  assert.equal(state.cells[0][1].t, "X", "patched cell written");
  assert.deepEqual(state.cur, [0, 1], "cursor updated");
  assert.ok(dirty.has(0), "changed + cursor row is dirty");
});

test("patchCells pads a growing row with blanks, never holes", () => {
  // A span starting past the current row end (canonical spaces upstream made
  // the in-between cells "unchanged") must not leave undefined holes.
  const state = { cells: [[{ t: "s" }, { t: "h" }]], cur: null as [number, number] | null };
  patchCells(state, { cur: null, rows: [{ r: 0, l: 4, cells: [{ t: "$" }] }] });
  assert.deepEqual(state.cells[0], [{ t: "s" }, { t: "h" }, { t: " " }, { t: " " }, { t: "$" }]);
  assert.doesNotThrow(() => renderRow(state.cells[0], -1));
});

test("patchCells tri-state cursor: undefined leaves it untouched", () => {
  const state = { cells: [[{ t: "a" }], [{ t: "b" }]], cur: [0, 0] as [number, number] | null };
  // Cursor unchanged (undefined): kept, and its row is NOT dirtied.
  const dirty = patchCells(state, { cur: undefined, rows: [{ r: 1, l: 0, cells: [{ t: "X" }] }] });
  assert.deepEqual(state.cur, [0, 0], "cursor untouched");
  assert.ok(!dirty.has(0), "cursor row not dirtied when unchanged");
  assert.ok(dirty.has(1), "patched row dirty");
  // Explicit null hides it (and dirties the old cursor row).
  const dirty2 = patchCells(state, { cur: null, rows: [] });
  assert.equal(state.cur, null);
  assert.ok(dirty2.has(0), "old cursor row re-rendered on hide");
});

test("patchCells marks both old and new cursor rows dirty", () => {
  const state = { cells: [[{ t: "a" }], [{ t: "b" }]], cur: [0, 0] as [number, number] | null };
  const dirty = patchCells(state, { cur: [1, 0], rows: [] });
  assert.ok(dirty.has(0), "old cursor row");
  assert.ok(dirty.has(1), "new cursor row");
});

test("decodeBlock expands runs, blanks, clusters, and style runs", () => {
  // "aBc" is one merged run — one cell per codepoint; the style run covers B.
  const cells = decodeBlock([["aBc"], [[1, 1, { f: 1, b: 1 }]]]);
  assert.deepEqual(cells, [{ t: "a" }, { t: "B", f: 1, b: 1 }, { t: "c" }]);
  // A blank cell rides as 0 between runs.
  assert.deepEqual(decodeBlock([["a", 0, "b"]]), [{ t: "a" }, { t: "" }, { t: "b" }]);
  // Strings split by CODEPOINT: an astral glyph is one cell, not two UTF-16 units.
  assert.deepEqual(decodeBlock([["x🚀y"]]), [{ t: "x" }, { t: "🚀" }, { t: "y" }]);
  // A multi-codepoint grapheme cell arrives as ["…"] and stays one cell.
  assert.deepEqual(decodeBlock([["a", ["é"], "b"]]), [
    { t: "a" },
    { t: "é" },
    { t: "b" },
  ]);
  // A style run spans multiple cells with one entry.
  assert.deepEqual(decodeBlock([["abcd"], [[0, 3, { d: 1 }]]]), [
    { t: "a", d: 1 },
    { t: "b", d: 1 },
    { t: "c", d: 1 },
    { t: "d" },
  ]);
  // An empty block decodes to no cells.
  assert.deepEqual(decodeBlock([[]]), []);
});

test("uniform spans decode one cell per codepoint with a shared style", () => {
  // Mirror of the applyCell/decodeRow bare-string rule.
  const expand = (text: string, style?: object) => {
    const cells: object[] = [];
    for (const ch of text) cells.push(style ? { t: ch, ...style } : { t: ch });
    return cells;
  };
  assert.deepEqual(expand("✶", { f: 174 }), [{ t: "✶", f: 174 }]);
  assert.deepEqual(expand("ok!", { f: 2 }), [
    { t: "o", f: 2 },
    { t: "k", f: 2 },
    { t: "!", f: 2 },
  ]);
  // Codepoint split: astral glyphs stay whole.
  assert.deepEqual(expand("a🚀"), [{ t: "a" }, { t: "🚀" }]);
});

test("flags as 1 style like true (weight, reverse, dim, wide)", () => {
  assert.equal(cellStyle({ f: 1, b: 1 }, false), "color:#cd0000;font-weight:bold;");
  assert.equal(cellStyle({ n: 1 }, false), "color:#000000;background:#d0d0d0;");
  assert.equal(cellStyle({ d: 1 }, false), "color:#787878;");
  // Wide flag as 1 advances two columns.
  const split = renderRow([{ t: "世", w: 1 }, { t: "a", b: 1 }], -1);
  assert.match(split, /left:2ch;width:1ch;font-weight:bold;">a</);
});
