// code-flow's preview overlay. The preview proxy (src/preview.ts) adds this script to the pages
// of an app shown in the side panel's Browser. It talks only to code-flow's own page, the frame's
// parent, with postMessage: it reports console errors and failed requests, lets you pick an
// element or draw a box to comment on (with a best-effort snapshot), shows the numbered pins, and
// tries style changes on a picked element (Adjust). It does nothing outside code-flow's frame.
(() => {
  if (window.top === window || window.__codeflowOverlay) return;
  window.__codeflowOverlay = true;
  const PARENTS = __PARENTS__;
  /** The code-flow origin that said hello: messages go only there. */
  let parent = null;
  const early = [];
  const post = (msg) => {
    if (parent) window.parent.postMessage({ codeflow: 1, ...msg }, parent);
    else if (msg.type === "console" && early.length < 200) early.push(msg);
  };

  // ------------------------------------------------------------ console and network
  const show = (a) => {
    if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
    if (typeof a === "object" && a !== null) {
      try {
        return JSON.stringify(a).slice(0, 500);
      } catch {
        return String(a);
      }
    }
    return String(a);
  };
  const report = (level, args) => post({ type: "console", level, text: args.map(show).join(" ").slice(0, 2000), at: Date.now() });
  for (const level of ["error", "warn"]) {
    const original = console[level];
    console[level] = (...args) => {
      report(level, args);
      return original.apply(console, args);
    };
  }
  addEventListener(
    "error",
    (e) => {
      // An image, script or stylesheet that fails to load fires a plain error event on its element.
      const el = e.target;
      if (el instanceof Element) {
        const url = [el.currentSrc, el.src, el.href].find((u) => typeof u === "string" && u) || el.getAttribute("href") || "";
        return report("network", [`failed to load ${el.tagName.toLowerCase()} ${url}`.trim()]);
      }
      report("error", [e.error || e.message || "Script error"]);
    },
    true,
  );
  addEventListener("unhandledrejection", (e) => report("error", ["Unhandled promise rejection:", e.reason]));
  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      const method = (init && init.method) || (input instanceof Request ? input.method : "GET");
      try {
        const res = await originalFetch(input, init);
        if (res.status >= 400) report("network", [`${res.status} ${method} ${url}`]);
        return res;
      } catch (err) {
        report("network", [`${method} ${url} failed: ${err && err.message}`]);
        throw err;
      }
    };
  }
  // One listener per request object, which a page may open again and again: it reports the
  // latest open. It listens for the request being done, which comes before load and loadend,
  // so a page that opens the next request from those still has this one reported.
  const xhrOpen = XMLHttpRequest.prototype.open;
  const opened = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (!opened.has(this)) {
      this.addEventListener("readystatechange", () => {
        if (this.readyState !== XMLHttpRequest.DONE) return;
        const { method, url } = opened.get(this);
        if (this.status === 0) report("network", [`${method} ${url} failed`]);
        else if (this.status >= 400) report("network", [`${this.status} ${method} ${url}`]);
      });
    }
    opened.set(this, { method, url });
    return xhrOpen.call(this, method, url, ...rest);
  };

  // ------------------------------------------------------------ where the page is
  const where = () => post({ type: "location", url: location.href, title: document.title });
  for (const name of ["pushState", "replaceState"]) {
    const original = history[name];
    history[name] = function (...args) {
      const result = original.apply(this, args);
      setTimeout(where);
      return result;
    };
  }
  addEventListener("popstate", where);
  addEventListener("hashchange", where);

  // ------------------------------------------------------------ the layer: highlight, box, pins
  // code-flow's paper palette, as literals (this runs inside other apps, with none of its CSS): mint
  // outlines, ink labels and numbers with a white ring, so they read on light and dark pages alike.
  // The panel's snapshot boxes and the PNG sent to agents use the same (ui/browser.tsx, ui/styles.css).
  const MARK = "#2a9b72";
  const MARK_FILL = "rgba(42,155,114,.1)";
  const INK = "#343932";
  const ON_INK = "#fbfaf6";
  const SANS = 'Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif';
  let layer;
  const ensureLayer = () => {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement("div");
    layer.setAttribute("data-codeflow", "");
    layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
    (document.body || document.documentElement).appendChild(layer);
    return layer;
  };
  const box = (cls) => {
    const el = document.createElement("div");
    el.className = cls;
    el.style.cssText = `position:absolute;border:2px solid ${MARK};border-radius:6px;background:${MARK_FILL};box-sizing:border-box;pointer-events:none;`;
    ensureLayer().appendChild(el);
    return el;
  };
  const label = document.createElement("div");
  label.style.cssText = `position:absolute;transform:translateY(calc(-100% - 4px));background:${INK};color:${ON_INK};font:500 11px/1.4 ui-monospace,"SFMono-Regular",Menlo,monospace;padding:2px 7px;border-radius:6px;box-shadow:0 1px 2px rgba(34,35,24,.12),0 4px 12px rgba(34,35,24,.14);white-space:nowrap;pointer-events:none;`;
  let highlight;
  const docRect = (r) => ({ x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) });
  const place = (el, r) => Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });

  const ours = (el) => !!(el && el.closest && el.closest("[data-codeflow]"));
  const selectorOf = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.body && parts.length < 5; node = node.parentElement) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(`#${node.id}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const classes = [...node.classList].filter((c) => /^[A-Za-z][\w-]*$/.test(c) && c.length < 32).slice(0, 2);
      if (classes.length) part += `.${classes.join(".")}`;
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      parts.unshift(part);
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  };
  const STYLES = ["color", "background-color", "font-family", "font-size", "font-weight", "line-height", "padding", "margin", "border", "border-radius", "display", "gap", "width", "height", "opacity"];
  const stylesOf = (el) => {
    const cs = getComputedStyle(el);
    return Object.fromEntries(STYLES.map((p) => [p, cs.getPropertyValue(p)]).filter(([, v]) => v && v !== "normal" && v !== "none" && v !== "auto"));
  };

  // ------------------------------------------------------------ snapshot: the DOM drawn into a PNG
  // An SVG image of a styled copy of the page; outside images and fonts don't load in it, and a
  // page that taints the canvas gets no snapshot. Best effort, never in the way.
  const SNAP = ["display", "position", "box-sizing", "width", "height", "min-height", "margin", "padding", "border", "border-radius", "background", "background-color", "color", "font", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "text-decoration", "text-transform", "white-space", "flex", "flex-direction", "flex-wrap", "align-items", "justify-content", "gap", "grid-template-columns", "grid-template-rows", "opacity", "box-shadow", "overflow", "vertical-align", "list-style", "top", "left", "right", "bottom", "transform", "z-index", "visibility"];
  const MAX_NODES = 1500;
  const styledCopy = (node) => {
    let count = 0;
    const copy = (src) => {
      if (count++ > MAX_NODES) return document.createTextNode("");
      if (src.nodeType === 3) return document.createTextNode(src.nodeValue);
      if (src.nodeType !== 1 || ours(src) || src.tagName === "SCRIPT" || src.tagName === "STYLE" || src.tagName === "IFRAME") return document.createTextNode("");
      const el = document.createElement(src.tagName === "BODY" || src.tagName === "HTML" ? "div" : src.tagName);
      const cs = getComputedStyle(src);
      el.setAttribute("style", SNAP.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
      if (src.tagName === "INPUT") {
        el.setAttribute("type", src.type);
        if (src.placeholder) el.setAttribute("placeholder", src.placeholder);
        if (src.type === "checkbox" || src.type === "radio") {
          if (src.checked) el.setAttribute("checked", "");
        } else {
          // A password never goes into a snapshot: dots stand in for it.
          el.setAttribute("value", src.type === "password" ? "\u2022".repeat(src.value.length) : src.value);
        }
        return el;
      }
      if (src.tagName === "TEXTAREA") {
        el.textContent = src.value;
        return el;
      }
      for (const child of src.childNodes) el.appendChild(copy(child));
      return el;
    };
    return copy(node);
  };
  const snapshot = async (node, rect) => {
    try {
      const scale = Math.min(1, 1600 / Math.max(rect.w, 1), 1200 / Math.max(rect.h, 1));
      const w = Math.max(1, Math.round(rect.w * scale));
      const h = Math.max(1, Math.round(rect.h * scale));
      const frame = document.createElement("div");
      frame.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
      if (node === document.body) {
        // A box on the page: the whole body, moved so the box is at the top left.
        frame.style.cssText = `width:${document.documentElement.scrollWidth}px;transform:translate(${-rect.x}px,${-rect.y}px);background:${getComputedStyle(document.body).backgroundColor || "#fff"}`;
      } else {
        frame.style.cssText = `width:${rect.w}px;height:${rect.h}px;overflow:hidden`;
      }
      frame.appendChild(styledCopy(node));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${rect.w} ${rect.h}"><foreignObject width="${node === document.body ? document.documentElement.scrollWidth : rect.w}" height="${node === document.body ? document.documentElement.scrollHeight : rect.h}">${new XMLSerializer().serializeToString(frame)}</foreignObject></svg>`;
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; if (img.complete && img.naturalWidth) resolve(); });
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL("image/png");
    } catch {
      return undefined;
    }
  };

  /** An element's HTML, without what's typed in its password fields (frameworks copy it into the value attribute). */
  const htmlOf = (el) => {
    const passwords = (node) => [...(node.matches("input[type=password]") ? [node] : []), ...node.querySelectorAll("input[type=password]")];
    if (!passwords(el).length) return el.outerHTML;
    const clone = el.cloneNode(true);
    for (const input of passwords(clone)) input.removeAttribute("value");
    return clone.outerHTML;
  };

  // ------------------------------------------------------------ pick and box
  let mode = "off";
  const picked = new Map();
  // Pin ids are new in every page load, so a pin the panel kept from an earlier page never names an element on this one.
  const load = Math.random().toString(36).slice(2, 10);
  let nextId = 1;
  const viewport = () => ({ w: innerWidth, h: innerHeight });
  const pin = async (kind, el, rect) => {
    const id = `${load}-${nextId++}`;
    if (kind === "element") picked.set(id, { el, original: el.style.cssText });
    post({ type: "pin-start", id });
    const image = await snapshot(kind === "element" ? el : document.body, rect);
    post({
      type: "pin",
      pin: {
        id,
        kind,
        selector: selectorOf(el),
        text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200),
        html: kind === "element" ? htmlOf(el).slice(0, 600) : undefined,
        styles: kind === "element" ? stylesOf(el) : undefined,
        rect,
        url: location.href,
        viewport: viewport(),
        image,
      },
    });
  };
  const onMove = (e) => {
    if (mode !== "pick") return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || ours(el)) return;
    highlight = highlight && highlight.isConnected ? highlight : box("cf-highlight");
    const r = docRect(el.getBoundingClientRect());
    place(highlight, r);
    label.textContent = selectorOf(el);
    Object.assign(label.style, { left: `${r.x}px`, top: `${r.y}px` });
    ensureLayer().appendChild(label);
  };
  const swallow = (e) => {
    if (mode === "off" || ours(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onClick = (e) => {
    if (mode !== "pick" || ours(e.target)) return;
    swallow(e);
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && !ours(el)) void pin("element", el, docRect(el.getBoundingClientRect()));
  };
  let drag;
  const onDown = (e) => {
    if (mode !== "box" || e.button !== 0) return;
    swallow(e);
    drag = { x: e.clientX + scrollX, y: e.clientY + scrollY, el: box("cf-drag") };
    drag.el.style.borderStyle = "dashed";
  };
  const onDrag = (e) => {
    if (!drag) return;
    const x = e.clientX + scrollX;
    const y = e.clientY + scrollY;
    place(drag.el, { x: Math.min(x, drag.x), y: Math.min(y, drag.y), w: Math.abs(x - drag.x), h: Math.abs(y - drag.y) });
  };
  const onUp = (e) => {
    if (!drag) return;
    swallow(e);
    const x = e.clientX + scrollX;
    const y = e.clientY + scrollY;
    const rect = { x: Math.min(x, drag.x), y: Math.min(y, drag.y), w: Math.abs(x - drag.x), h: Math.abs(y - drag.y) };
    drag.el.remove();
    drag = undefined;
    if (rect.w < 8 || rect.h < 8) return;
    const center = document.elementFromPoint(rect.x + rect.w / 2 - scrollX, rect.y + rect.h / 2 - scrollY) || document.body;
    void pin("box", ours(center) ? document.body : center, rect);
  };
  const setMode = (next) => {
    mode = next;
    document.documentElement.style.cursor = mode === "off" ? "" : "crosshair";
    if (mode !== "pick") {
      if (highlight) highlight.remove();
      label.remove();
    }
  };
  // Pointer events for the box. Cancelling a press stops the mouse events that would follow it,
  // but not the click (or a right or middle click), so those are swallowed too.
  addEventListener("mousemove", onMove, true);
  addEventListener("pointermove", onDrag, true);
  addEventListener("click", onClick, true);
  addEventListener("pointerdown", onDown, true);
  addEventListener("pointerup", onUp, true);
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "contextmenu", "dblclick", "submit"]) addEventListener(type, swallow, true);
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mode !== "off") {
      setMode("off");
      post({ type: "mode", mode: "off" });
    }
  });

  /** The numbered markers, where the panel says its pins are. */
  const drawPins = (pins) => {
    ensureLayer();
    for (const old of layer.querySelectorAll(".cf-pin, .cf-pinbox")) old.remove();
    for (const p of pins) {
      const outline = box("cf-pinbox");
      place(outline, p.rect);
      outline.style.borderStyle = p.kind === "box" ? "dashed" : "solid";
      outline.style.background = "transparent";
      const dot = document.createElement("div");
      dot.className = "cf-pin";
      dot.textContent = String(p.n);
      dot.style.cssText = `position:absolute;left:${p.rect.x + p.rect.w - 9}px;top:${p.rect.y - 9}px;width:18px;height:18px;border-radius:50%;background:${INK};color:${ON_INK};font:600 11px ${SANS};display:grid;place-items:center;box-shadow:0 0 0 2px #fff;pointer-events:none;`;
      layer.appendChild(dot);
    }
  };

  /** Adjust: try style changes on a picked element; an empty value puts the page's own back. */
  const adjust = (id, styles) => {
    const entry = picked.get(id);
    if (!entry) return post({ type: "adjust-gone", id });
    for (const [prop, value] of Object.entries(styles)) {
      if (value) entry.el.style.setProperty(prop, value);
      else entry.el.style.removeProperty(prop);
    }
  };
  const reset = (id) => {
    const entry = picked.get(id);
    if (!entry) return;
    // Through the style object, not the attribute: a page whose policy forbids inline styles still allows this.
    entry.el.style.cssText = entry.original;
    if (!entry.original) entry.el.removeAttribute("style");
  };

  addEventListener("message", (e) => {
    const m = e.data;
    if (e.source !== window.parent || !PARENTS.includes(e.origin) || !m || m.codeflow !== 1) return;
    if (m.type === "hello") {
      parent = e.origin;
      post({ type: "ready", url: location.href, title: document.title });
      for (const msg of early.splice(0)) post(msg);
    } else if (m.type === "mode") setMode(m.mode);
    else if (m.type === "pins") drawPins(m.pins || []);
    else if (m.type === "adjust") adjust(m.id, m.styles || {});
    else if (m.type === "reset") reset(m.id);
  });
})();
