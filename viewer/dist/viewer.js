export function decodeCells(text, runs) {
    const cells = [];
    for (const v of text) {
        if (typeof v === "number")
            cells.push({ t: "" });
        else if (typeof v === "string")
            for (const ch of v)
                cells.push({ t: ch });
        else
            cells.push({ t: v[0] });
    }
    for (const [start, len, st] of runs ?? []) {
        for (let i = start; i < start + len && i < cells.length; i++) {
            cells[i] = { t: cells[i].t, ...st };
        }
    }
    return cells;
}
export function decodeBlock(block) {
    return decodeCells(block[0] ?? [], block[1]);
}
let cfg;
export function setConfig(c) {
    cfg = c;
}
let proto;
let jsTag;
export function setProto(p, js) {
    proto = p;
    jsTag = js;
}
export let reloadPage = () => {
    try {
        const last = Number(sessionStorage.getItem("sg-reload") ?? 0);
        if (Date.now() - last < 5000)
            return;
        sessionStorage.setItem("sg-reload", String(Date.now()));
    }
    catch (e) {
    }
    location.reload();
};
export function setReloadPage(f) {
    reloadPage = f;
}
const BASE16 = [
    [0x00, 0x00, 0x00], [0xcd, 0x00, 0x00], [0x00, 0xcd, 0x00], [0xcd, 0xcd, 0x00],
    [0x00, 0x00, 0xee], [0xcd, 0x00, 0xcd], [0x00, 0xcd, 0xcd], [0xe5, 0xe5, 0xe5],
    [0x7f, 0x7f, 0x7f], [0xff, 0x00, 0x00], [0x00, 0xff, 0x00], [0xff, 0xff, 0x00],
    [0x5c, 0x5c, 0xff], [0xff, 0x00, 0xff], [0x00, 0xff, 0xff], [0xff, 0xff, 0xff],
];
export function palette(i) {
    if (i < 16)
        return BASE16[i];
    if (i < 232) {
        const n = i - 16;
        const L = [0, 95, 135, 175, 215, 255];
        return [L[Math.floor(n / 36)], L[Math.floor(n / 6) % 6], L[n % 6]];
    }
    const v = 8 + 10 * (i - 232);
    return [v, v, v];
}
function hex(c) {
    return "#" + c.map((x) => x.toString(16).padStart(2, "0")).join("");
}
function parseHex(s) {
    return [
        parseInt(s.slice(1, 3), 16),
        parseInt(s.slice(3, 5), 16),
        parseInt(s.slice(5, 7), 16),
    ];
}
export function resolveRgb(c) {
    if (c == null)
        return null;
    if (typeof c === "number")
        return palette(c);
    return c;
}
export function cellStyle(cell, isCursor) {
    let fg = resolveRgb(cell.f);
    let bg = resolveRgb(cell.g);
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
    if (fg)
        s += `color:${hex(fg)};`;
    if (bg)
        s += `background:${hex(bg)};`;
    if (cell.b)
        s += "font-weight:bold;";
    if (cell.i)
        s += "font-style:italic;";
    if (cell.u)
        s += "text-decoration:underline;";
    return s;
}
let metrics = { cellW: 8, cellH: 17, fontSize: 14 };
export function setMetrics(m) {
    metrics = m;
}
function wpx(weight) {
    const light = Math.max(1, Math.round(metrics.fontSize / 14));
    return weight >= 2 ? 2 * light : light;
}
function f(x) {
    return String(Math.round(x * 1e4) / 1e4);
}
function rect(x0, y0, x1, y1) {
    return `<rect x="${f(x0)}" y="${f(y0)}" width="${f(x1 - x0)}" height="${f(y1 - y0)}"/>`;
}
function hband(y, x0, x1, weight) {
    const h = wpx(weight) / metrics.cellH / 2;
    return rect(x0, y - h, x1, y + h);
}
function vband(x, y0, y1, weight) {
    const w = wpx(weight) / metrics.cellW / 2;
    return rect(x - w, y0, x + w, y1);
}
function arms(u, r, d, l) {
    const eps = wpx(1) / 2;
    const vw = Math.max(u ? wpx(u) / 2 : 0, d ? wpx(d) / 2 : 0, eps) / metrics.cellW;
    const hh = Math.max(l ? wpx(l) / 2 : 0, r ? wpx(r) / 2 : 0, eps) / metrics.cellH;
    const ov = OVERSHOOT / metrics.cellH;
    let s = "";
    if (u)
        s += vband(0.5, -ov, 0.5 + hh, u);
    if (d)
        s += vband(0.5, 0.5 - hh, 1 + ov, d);
    if (l)
        s += hband(0.5, 0, 0.5 + vw, l);
    if (r)
        s += hband(0.5, 0.5 - vw, 1, r);
    return s;
}
const OVERSHOOT = 0.5;
const ARMS = "0101020210102020" +
    "0000000000000000" +
    "0000000000000000" +
    "0110021001200220" +
    "0011001200210022" +
    "1100120021002200" +
    "1001100220012002" +
    "1110121021101120" +
    "2120221012202220" +
    "1011101220111021" +
    "2021201210222022" +
    "0111011202110212" +
    "0121012202210222" +
    "1101110212011202" +
    "2101210222012202" +
    "1111111212111212" +
    "2111112121212112" +
    "2211112212212212" +
    "1222212222212222" +
    "0000000000000000" +
    "0000000000000000" +
    "0000000000000000" +
    "0000000000000000" +
    "0000000000000000" +
    "0000000000000000" +
    "0000000000000000" +
    "0000000000000000" +
    "0000000000000000" +
    "0000000000000000" +
    "0001100001000010" +
    "0002200002000020" +
    "0201102001022010";
function dashes(horiz, n, weight) {
    let s = "";
    const seg = 1 / n;
    const dash = seg * 0.6;
    for (let i = 0; i < n; i++) {
        const a = i * seg + (seg - dash) / 2;
        s += horiz ? hband(0.5, a, a + dash, weight) : vband(0.5, a, a + dash, weight);
    }
    return s;
}
function dashGlyph(cp) {
    if (cp <= 0x250b) {
        const k = cp - 0x2504;
        return dashes((k & 3) < 2, k < 4 ? 3 : 4, k & 1 ? 2 : 1);
    }
    const k = cp - 0x254c;
    return dashes(k < 2, 2, k & 1 ? 2 : 1);
}
const DOUBLES = [
    [0, 0, 1, 1, 0, 1],
    [1, 1, 0, 0, 1, 0],
    [0, 1, 0, 1, 0, 1],
    [0, 1, 0, 1, 1, 0],
    [0, 1, 0, 1, 1, 1],
    [0, 1, 1, 0, 0, 1],
    [0, 1, 1, 0, 1, 0],
    [0, 1, 1, 0, 1, 1],
    [1, 0, 0, 1, 0, 1],
    [1, 0, 0, 1, 1, 0],
    [1, 0, 0, 1, 1, 1],
    [1, 0, 1, 0, 0, 1],
    [1, 0, 1, 0, 1, 0],
    [1, 0, 1, 0, 1, 1],
    [1, 1, 0, 1, 0, 1],
    [1, 1, 0, 1, 1, 0],
    [1, 1, 0, 1, 1, 1],
    [1, 1, 1, 0, 0, 1],
    [1, 1, 1, 0, 1, 0],
    [1, 1, 1, 0, 1, 1],
    [0, 1, 1, 1, 0, 1],
    [0, 1, 1, 1, 1, 0],
    [0, 1, 1, 1, 1, 1],
    [1, 0, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0],
    [1, 0, 1, 1, 1, 1],
    [1, 1, 1, 1, 0, 1],
    [1, 1, 1, 1, 1, 0],
    [1, 1, 1, 1, 1, 1],
];
function doubleGlyph(cp) {
    const [u, d, l, r, vd, hd] = DOUBLES[cp - 0x2550];
    const hw = wpx(1) / metrics.cellW / 2;
    const hh = wpx(1) / metrics.cellH / 2;
    const dh = wpx(1) / metrics.cellW;
    const dv = wpx(1) / metrics.cellH;
    const maxDv = hd ? dv : 0;
    const maxDh = vd ? dh : 0;
    const ov = OVERSHOOT / metrics.cellH;
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
function arc(cx, cy) {
    const tx = wpx(1) / metrics.cellW / 2;
    const ty = wpx(1) / metrics.cellH / 2;
    const sx = cx === 1 ? -1 : 1;
    const sy = cy === 1 ? -1 : 1;
    const aOut = 0.5 + sx * tx;
    const aIn = 0.5 - sx * tx;
    const bOut = 0.5 + sy * ty;
    const bIn = 0.5 - sy * ty;
    const sweep = sx * sy < 0 ? 0 : 1;
    return (`<path d="M ${f(aOut)} ${f(cy)} A ${f(0.5 + tx)} ${f(0.5 + ty)} 0 0 ${sweep} ${f(cx)} ${f(bOut)} ` +
        `L ${f(cx)} ${f(bIn)} A ${f(0.5 - tx)} ${f(0.5 - ty)} 0 0 ${1 - sweep} ${f(aIn)} ${f(cy)} Z"/>`);
}
function arcGlyph(cp) {
    const c = [
        [1, 1],
        [0, 1],
        [0, 0],
        [1, 0],
    ][cp - 0x256d];
    return arc(c[0], c[1]);
}
function diag(x0, y0, x1, y1) {
    const dxp = (x1 - x0) * metrics.cellW;
    const dyp = (y1 - y0) * metrics.cellH;
    const len = Math.hypot(dxp, dyp);
    const t = wpx(1) / 2;
    const ux = (-dyp / len) * t / metrics.cellW;
    const uy = (dxp / len) * t / metrics.cellH;
    return (`<path d="M ${f(x0 + ux)} ${f(y0 + uy)} L ${f(x1 + ux)} ${f(y1 + uy)} ` +
        `L ${f(x1 - ux)} ${f(y1 - uy)} L ${f(x0 - ux)} ${f(y0 - uy)} Z"/>`);
}
function diagGlyph(cp) {
    const up = cp !== 0x2572 ? diag(0, 1, 1, 0) : "";
    const down = cp !== 0x2571 ? diag(0, 0, 1, 1) : "";
    return up + down;
}
const QUADRANTS = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14];
function blockElement(cp) {
    if (cp === 0x2580)
        return rect(0, 0, 1, 0.5);
    if (cp >= 0x2581 && cp <= 0x2588)
        return rect(0, 1 - (cp - 0x2580) / 8, 1, 1);
    if (cp >= 0x2589 && cp <= 0x258f)
        return rect(0, 0, (0x2590 - cp) / 8, 1);
    if (cp === 0x2590)
        return rect(0.5, 0, 1, 1);
    if (cp <= 0x2593) {
        const op = (cp - 0x2590) / 4;
        return `<rect x="0" y="0" width="1" height="1" fill-opacity="${op}"/>`;
    }
    if (cp === 0x2594)
        return rect(0, 0, 1, 0.125);
    if (cp === 0x2595)
        return rect(0.875, 0, 1, 1);
    const m = QUADRANTS[cp - 0x2596];
    let s = "";
    if (m & 1)
        s += rect(0, 0, 0.5, 0.5);
    if (m & 2)
        s += rect(0.5, 0, 1, 0.5);
    if (m & 4)
        s += rect(0, 0.5, 0.5, 1);
    if (m & 8)
        s += rect(0.5, 0.5, 1, 1);
    return s;
}
function boxDrawing(cp) {
    if ((cp >= 0x2504 && cp <= 0x250b) || (cp >= 0x254c && cp <= 0x254f))
        return dashGlyph(cp);
    if (cp >= 0x2550 && cp <= 0x256c)
        return doubleGlyph(cp);
    if (cp >= 0x256d && cp <= 0x2570)
        return arcGlyph(cp);
    if (cp >= 0x2571 && cp <= 0x2573)
        return diagGlyph(cp);
    const o = (cp - 0x2500) * 4;
    return arms(+ARMS[o], +ARMS[o + 1], +ARMS[o + 2], +ARMS[o + 3]);
}
export function glyphGeometry(cp) {
    if (cp >= 0x2500 && cp <= 0x257f)
        return boxDrawing(cp);
    if (cp >= 0x2580 && cp <= 0x259f)
        return blockElement(cp);
    return null;
}
export function isFillGlyph(cp) {
    return ((cp >= 0xe0b0 && cp <= 0xe0d4) ||
        (cp >= 0x2500 && cp <= 0x259f) ||
        (cp >= 0x1fb00 && cp <= 0x1fbaf));
}
export function isMergeableFill(cp) {
    return (cp === 0x2500 ||
        cp === 0x2501 ||
        cp === 0x2550 ||
        cp === 0x2580 ||
        cp === 0x2588 ||
        (cp >= 0x2581 && cp <= 0x2587) ||
        (cp >= 0x2591 && cp <= 0x2593) ||
        cp === 0x2594);
}
function symbolFamily(cp) {
    for (const [lo, hi, fam] of cfg.sym) {
        if (cp >= lo && cp <= hi)
            return fam;
    }
    return null;
}
function svgFont(cell) {
    const t = cell.t ?? "";
    if (!t)
        return null;
    const cp = t.codePointAt(0);
    const fam = symbolFamily(cp);
    if (fam)
        return fam;
    return isFillGlyph(cp) ? cfg.fillFont : null;
}
function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function symbolSpan(col, w, boxStyle, font, glyph, first) {
    const fill = isFillGlyph(first);
    const par = fill ? "none" : "xMidYMid meet";
    const stretch = fill ? ' textLength="14" lengthAdjust="spacingAndGlyphs"' : "";
    return (`<span class="run" style="left:${col}ch;width:${w}ch;${boxStyle}">` +
        `<svg viewBox="0 0 14 14" preserveAspectRatio="${par}" style="display:block;width:100%;height:100%">` +
        `<text x="0" y="12" font-family="${font}" font-size="14" fill="currentColor"${stretch}>${glyph}</text></svg></span>`);
}
function symbolCell(cell, isCursor, col, w, font) {
    const boxStyle = cellStyle(cell, isCursor);
    const t = cell.t ?? " ";
    return symbolSpan(col, w, boxStyle, font, esc(t), t.codePointAt(0) ?? 0x20);
}
function geomSpan(col, w, boxStyle, geom) {
    const crisp = geom.includes("<path") ? "" : ' shape-rendering="crispEdges"';
    return (`<span class="run" style="left:${col}ch;width:${w}ch;overflow:visible;${boxStyle}">` +
        `<svg viewBox="0 0 1 1" preserveAspectRatio="none" fill="currentColor" overflow="visible"${crisp} style="display:block;width:100%;height:100%">${geom}</svg></span>`);
}
export function renderRow(cells, cursorCol) {
    let out = "";
    let col = 0;
    let runStyle = null;
    let runCol = 0;
    let cols = 0;
    let text = "";
    const flushText = () => {
        if (text.length === 0)
            return;
        out += `<span class="run" style="left:${runCol}ch;width:${cols}ch;${runStyle ?? ""}">${text}</span>`;
        text = "";
    };
    let fill = null;
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
        const first = t ? t.codePointAt(0) : 0x20;
        const geom = t && !(first >= 0xe000 && first <= 0xf8ff && symbolFamily(first))
            ? glyphGeometry(first)
            : null;
        const font = geom ? null : svgFont(cell);
        if (geom || font) {
            flushText();
            runStyle = null;
            cols = 0;
            if (isMergeableFill(first)) {
                const style = cellStyle(cell, isCursor);
                if (fill &&
                    fill.t === t &&
                    fill.style === style &&
                    fill.font === (font ?? "") &&
                    fill.geom === geom) {
                    fill.width += w;
                }
                else {
                    flushFill();
                    fill = { col, width: w, t, glyph: esc(t || " "), style, font: font ?? "", first, geom };
                }
            }
            else {
                flushFill();
                out += geom
                    ? geomSpan(col, w, cellStyle(cell, isCursor), geom)
                    : symbolCell(cell, isCursor, col, w, font);
            }
        }
        else {
            flushFill();
            const style = cellStyle(cell, isCursor);
            if (runStyle !== style) {
                flushText();
                runStyle = style;
                cols = 0;
            }
            if (cols === 0)
                runCol = col;
            text += esc(cell.t && cell.t.length ? cell.t : " ");
            cols += w;
        }
        col += w;
    }
    flushText();
    flushFill();
    return out;
}
function cursorCol(cur, row) {
    return cur && cur[0] === row ? cur[1] : -1;
}
let screen = { cells: [], cur: null, rowEls: [] };
let screenEl;
export function patchCells(state, dp) {
    const dirty = new Set();
    if (dp.cur !== undefined) {
        if (state.cur)
            dirty.add(state.cur[0]);
        if (dp.cur)
            dirty.add(dp.cur[0]);
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
            while (row.length < i)
                row.push({ t: " " });
            row[i] = patch.cells[dx];
        }
        dirty.add(patch.r);
    }
    return dirty;
}
function applyFull(m) {
    const cur = m.p ?? null;
    const rows = m.d.map(decodeBlock);
    let html = `<div class="screen" style="width:${m.w}ch;height:calc(${m.h} * var(--lh));">`;
    for (let r = 0; r < rows.length; r++) {
        html += `<div class="row">${renderRow(rows[r], cursorCol(cur, r))}</div>`;
    }
    html += "</div>";
    screenEl.innerHTML = html;
    const screenDiv = screenEl.firstElementChild;
    screen = {
        cells: rows,
        cur,
        rowEls: Array.from(screenDiv.children),
    };
}
function decodeRow([r, l, text, style]) {
    if (typeof text === "string") {
        const st = style;
        const cells = [];
        for (const ch of text)
            cells.push(st ? { t: ch, ...st } : { t: ch });
        return { r, l, cells };
    }
    return { r, l, cells: decodeCells(text, style) };
}
function applyPatches(cur, rows) {
    const dirty = patchCells(screen, { cur, rows });
    for (const r of dirty) {
        const el = screen.rowEls[r];
        if (!el)
            continue;
        el.innerHTML = renderRow(screen.cells[r] ?? [], cursorCol(screen.cur, r));
    }
}
function applyDiff(m) {
    applyPatches(m.p, (m.r ?? []).map(decodeRow));
}
function applyCell(m) {
    const { c: r, p: _p, ...style } = m;
    const styled = Object.keys(style).length > 0;
    const cells = [];
    for (const ch of r[2])
        cells.push(styled ? { t: ch, ...style } : { t: ch });
    applyPatches(m.p, [{ r: r[0], l: r[1], cells }]);
}
function applyLine(m) {
    applyPatches(m.p, [decodeRow(m.l)]);
}
function applyBanner(m) {
    screenEl.innerHTML = m.b;
    screen = { cells: [], cur: null, rowEls: [] };
}
export function apply(m) {
    if ("v" in m) {
        const wireChanged = proto !== undefined && m.v !== proto;
        const jsChanged = jsTag !== undefined && m.js !== undefined && m.js !== jsTag;
        if (wireChanged || jsChanged)
            reloadPage();
        return;
    }
    if ("c" in m)
        applyCell(m);
    else if ("l" in m)
        applyLine(m);
    else if ("d" in m)
        applyFull(m);
    else if ("b" in m)
        applyBanner(m);
    else
        applyDiff(m);
}
function connect(events) {
    const es = new EventSource(events);
    es.onmessage = (e) => apply(JSON.parse(e.data));
    es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
            setTimeout(() => connect(events), 2000);
        }
    };
}
function measureMetrics() {
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
function main() {
    const boot = window.SHELLGLASS;
    setConfig(boot.cfg);
    setProto(boot.proto, boot.js);
    screenEl = document.getElementById("screen");
    measureMetrics();
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
if (typeof document !== "undefined" && window.SHELLGLASS) {
    main();
}
