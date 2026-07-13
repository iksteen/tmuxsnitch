// shellglass embed — the STABLE public embedding API. One line where the
// terminal should appear:
//
//   <script src="https://hub.example.com/embed.js"
//           data-src="https://hub.example.com/s/demo"></script>
//
// The script replaces itself with a <shellglass-view> element. By default the
// terminal renders IFRAME-LESS, straight into the host page (light DOM), so
// there is no frame to fight a strict CSP or to style around. Two opt-in modes:
//
//   data-mode / mode = "shadow"  render in a shadow root (style-isolated from
//                                the host; note: native selection across a
//                                shadow boundary is weaker on some browsers)
//   data-mode / mode = "iframe"  the classic sandboxed <iframe> onto ?embed
//
//   <shellglass-view src="https://hub.example.com/s/demo"></shellglass-view>
//   <shellglass-view src="/s/demo" mode="shadow"></shellglass-view>
//
// Same-origin is the easy case: put the hub behind a reverse proxy on your own
// domain (e.g. /term/ -> the hub) and point `src` at that path — every asset the
// viewer fetches is relative to `src`, so nothing is cross-origin and no CORS is
// needed. For a genuinely cross-origin embed, run the hub/serve with
// --cors-origin <your-page-origin>.
//
// The iframe-less (light/shadow) modes don't touch the host page's tab title;
// instead the session's window title rides a `shellglass-title` CustomEvent on
// the element (event.detail = the title, "" on clear), so the host decides what
// to do with it:  el.addEventListener("shellglass-title", e => …).
//
// A CLASSIC script on purpose: document.currentScript doesn't exist in modules,
// and classic cross-origin loads need no CORS. This file stays tiny and
// backward compatible: never remove or repurpose `data-src`, the element name,
// or its `src` attribute. The live rendering lives in viewer.js (imported per
// element), so this shim has no version coupling to it.
(() => {
  // Directory-shaped base for a session `src`: the routes (config, events,
  // style.css, viewer.js, images/…) all live under it, and every fetch is
  // resolved against it — so a reverse proxy can mount the hub under any prefix.
  const baseOf = (src) => {
    const u = new URL(src, location.href);
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    return u.href;
  };
  // iframe mode targets the chrome-less ?embed page.
  const embedUrl = (src) => {
    try {
      const u = new URL(src, location.href);
      u.searchParams.set("embed", "");
      return u.href;
    } catch {
      return null;
    }
  };

  // Zero-specificity defaults so ANY host rule overrides them without
  // !important; a style attribute (carried from the one-liner) beats both.
  // inline-block + fit-content: an UNSIZED element is exactly the terminal's
  // natural size (independent of the parent's width). Give it a width/height
  // and it becomes the frame the terminal is scaled to fill (see fitToBox);
  // overflow:hidden clips the letterbox margin.
  if (!document.getElementById("shellglass-embed-css")) {
    const st = document.createElement("style");
    st.id = "shellglass-embed-css";
    st.textContent =
      ":where(shellglass-view){display:inline-block;overflow:hidden;vertical-align:top}" +
      ":where(iframe.shellglass-view){display:block;border:0;width:100%;height:24em}" +
      // Minimal operator-offline hint for the iframe-less modes (the ?embed page
      // brings its own). Dims and labels; a host rule can restyle or hide it.
      "shellglass-view[data-offline]{opacity:.65}" +
      'shellglass-view[data-offline]::after{content:"operator offline";' +
      "position:absolute;left:0;right:0;top:.5em;text-align:center;" +
      "font:600 12px system-ui,sans-serif;color:#fff;pointer-events:none}";
    document.head.append(st);
  }

  // Render the viewer straight into the host (light DOM) or a shadow root. The
  // viewer is pointed at `host`-scoped mount targets so it never reaches into
  // the host document (title, offline state, injected CSS all stay local).
  async function mountInline(host, src, shadow) {
    const base = baseOf(src);
    const cssRoot = shadow
      ? host.shadowRoot || host.attachShadow({ mode: "open" })
      : document.head;
    const scope = shadow ? "" : "shellglass-view ";
    // A wrapper carries the base font/metrics/backdrop; the inner screen div is
    // the mount the viewer fills. Font-family/size/--lh live on the wrapper so
    // the screen inherits them (the viewer reads them off getComputedStyle) and
    // the viewer's own paint of screen.style.color can't clobber them.
    const wrap = document.createElement("div");
    const screen = document.createElement("div");
    wrap.appendChild(screen);
    (shadow ? cssRoot : host).appendChild(wrap);

    let boot;
    try {
      boot = await fetch(base + "config", { credentials: "omit" }).then((r) => r.json());
    } catch {
      return; // hub unreachable: leave the box empty rather than throw
    }
    const cfg = boot.cfg || {};
    // The wrap renders at the terminal's NATURAL size (fit-content); fitToBox
    // scales it (CSS zoom) into the host element's box when the host sizes it.
    wrap.style.cssText =
      "display:block;position:relative;width:fit-content;" +
      `font-family:${cfg.fillFont || "monospace"};font-size:${cfg.fontPx || 14}px;` +
      `--lh:${cfg.lhPx || 16.8}px;line-height:var(--lh);` +
      `color:${cfg.defFg || "#d0d0d0"};background:${cfg.defBg || "#000"}`;
    // @font-face for the served fonts. A <link> (not inlined text) so the
    // relative font URLs inside resolve against the stylesheet's own URL (the
    // hub), not the host page. Fonts register document-wide either way.
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = base + "style.css";
    cssRoot.appendChild(link);

    let mod;
    try {
      mod = await import(base + "viewer.js?v=" + (boot.js || ""));
    } catch {
      return; // viewer failed to load
    }
    mod.mount({
      screen,
      boot: { events: base + "events", cfg, proto: boot.proto, js: boot.js },
      cssRoot,
      cssScope: scope,
      uiRoot: shadow ? cssRoot : wrap,
      base, // prefixes content-addressed image URLs onto the hub
      crossOriginImages: true,
      // Never hijack the host page's tab title — instead surface the session's
      // window title (OSC 0/2; "" on clear) as a `shellglass-title` event on the
      // element, so the host can propagate it however it likes. bubbles/composed
      // so a listener on an ancestor (or outside a shadow host) still catches it.
      title: (t) =>
        host.dispatchEvent(
          new CustomEvent("shellglass-title", { detail: t, bubbles: true, composed: true }),
        ),
      offline: (s) => {
        if (s) host.dataset.offline = s;
        else delete host.dataset.offline;
      },
    });
    fitToBox(host, wrap);
  }

  // Scale the natural-size `wrap` to fill the `host` element's box via CSS zoom
  // (which the viewer re-rasterizes crisp on "sg-zoom", like the ?embed page).
  // The host defaults to fit-content, so an UNSIZED element measures its own
  // natural size → z=1 → no scaling; give it a width/height and it becomes the
  // frame. Re-fits when the host box changes or the grid (wrap's natural size)
  // changes. Grows and shrinks, letterboxed (aspect preserved).
  function fitToBox(host, wrap) {
    const fit = () => {
      wrap.style.zoom = "1"; // measure natural size (and let a fit-content host relax to it)
      const nw = wrap.offsetWidth,
        nh = wrap.offsetHeight;
      const availW = host.clientWidth,
        availH = host.clientHeight;
      if (!nw || !nh || !availW || !availH) return;
      let z = Math.min(availW / nw, availH / nh);
      if (!isFinite(z) || z <= 0) return;
      if (z < 1) z *= 0.999; // shrinking: a hair under exact so rounding can't overflow the box
      wrap.style.zoom = String(z);
      window.dispatchEvent(new Event("sg-zoom")); // viewer re-rasterizes the canvas at the new scale
    };
    const ro = new ResizeObserver(fit);
    ro.observe(host); // the frame changed (host CSS size)
    ro.observe(wrap); // the terminal's natural size changed (grid resize)
    fit();
  }

  // The custom element. mode="light" (default) | "shadow" | "iframe".
  if (!customElements.get("shellglass-view")) {
    class ShellglassView extends HTMLElement {
      static observedAttributes = ["src"];
      connectedCallback() {
        if (this._mounted) return; // single-shot: set src/mode before insertion
        const src = this.getAttribute("src");
        if (!src) return;
        this._mounted = true;
        const mode = (this.getAttribute("mode") || "light").toLowerCase();
        if (mode === "iframe") {
          const root = this.attachShadow({ mode: "open" });
          const style = document.createElement("style");
          style.textContent =
            ":host{display:block;height:24em}" +
            "iframe{border:0;display:block;width:100%;height:100%}";
          this.frame = document.createElement("iframe");
          this.frame.title = "shellglass terminal";
          const href = embedUrl(src);
          if (href) this.frame.src = href;
          root.append(style, this.frame);
        } else {
          mountInline(this, src, mode === "shadow");
        }
      }
      attributeChangedCallback() {
        // Live re-point only makes sense for the iframe; the inline viewer is a
        // one-shot mount (set src before inserting the element).
        if (!this.frame) return;
        const href = embedUrl(this.getAttribute("src"));
        if (href && this.frame.src !== href) this.frame.src = href;
      }
    }
    customElements.define("shellglass-view", ShellglassView);
  }

  // One-liner form: replace the <script data-src> tag with an element carrying
  // the same src/mode/style. All rendering then lives in the element above.
  const me = document.currentScript;
  if (me && me.dataset.src) {
    const el = document.createElement("shellglass-view");
    el.setAttribute("src", me.dataset.src);
    if (me.dataset.mode) el.setAttribute("mode", me.dataset.mode);
    const style = me.getAttribute("style");
    if (style) el.style.cssText = style;
    me.replaceWith(el);
  }
})();
