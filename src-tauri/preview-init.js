// Injected into the preview webview (project dev server). Provides: element picker overlay,
// console/error capture. Reports reach the main webview as "preview:report" events (core event plugin).
(() => {
  if (window.__vibecoderPreview) return;
  const report = (kind, payload) => {
    try {
      const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (inv) inv("plugin:event|emit", { event: "preview:report", payload: { kind, payload } }).catch(() => {});
    } catch (e) {}
  };
  const state = { picking: false, overlay: null, label: null, last: null };

  function ensureOverlay() {
    if (state.overlay) return;
    const o = document.createElement("div");
    o.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #F72E87;background:rgba(247,46,135,0.08);border-radius:3px;transition:all 60ms;display:none";
    const l = document.createElement("div");
    l.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;background:#F72E87;color:#fff;font:12px/1.4 ui-monospace,monospace;padding:2px 6px;border-radius:3px;display:none;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    document.documentElement.appendChild(o);
    document.documentElement.appendChild(l);
    state.overlay = o; state.label = l;
  }

  function reactInfo(el) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    if (!key) return null;
    let fiber = el[key];
    const comps = [];
    let source = null;
    let guard = 0;
    while (fiber && guard++ < 200) {
      const t = fiber.type;
      if (typeof t === "function" || (t && typeof t === "object" && (t.displayName || t.name))) {
        const name = t.displayName || t.name || (t.render && (t.render.displayName || t.render.name));
        if (name && !comps.includes(name)) comps.push(name);
      }
      if (!source && fiber._debugSource) {
        const s = fiber._debugSource;
        source = `${s.fileName}:${s.lineNumber}`;
      }
      fiber = fiber.return;
    }
    return { components: comps.slice(0, 6), source };
  }

  function describe(el) {
    const rect = el.getBoundingClientRect();
    const attrs = {};
    for (const a of el.attributes) if (a.name.startsWith("data-") || a.name === "id" || a.name === "aria-label" || a.name === "name") attrs[a.name] = a.value.slice(0, 80);
    const classes = [...el.classList].slice(0, 12);
    const path = [];
    let cur = el; let depth = 0;
    while (cur && cur.nodeType === 1 && depth++ < 6) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) seg += "#" + cur.id;
      else if (cur.classList.length) seg += "." + [...cur.classList].slice(0, 2).join(".");
      path.unshift(seg);
      cur = cur.parentElement;
    }
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes,
      text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
      attrs,
      selector: path.join(" > "),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      react: reactInfo(el),
      url: location.href,
    };
  }

  function onMove(e) {
    if (!state.picking) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === state.overlay || el === state.label) return;
    state.last = el;
    const r = el.getBoundingClientRect();
    const o = state.overlay; o.style.display = "block";
    o.style.left = r.left + "px"; o.style.top = r.top + "px"; o.style.width = r.width + "px"; o.style.height = r.height + "px";
    const info = describe(el);
    const l = state.label; l.style.display = "block";
    l.textContent = (info.react && info.react.components[0] ? "<" + info.react.components[0] + "> " : "") + info.selector.split(" > ").pop();
    l.style.left = Math.max(0, r.left) + "px"; l.style.top = Math.max(0, r.top - 22) + "px";
  }
  function onClick(e) {
    if (!state.picking) return;
    e.preventDefault(); e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY) || state.last;
    if (el) report("pick", describe(el));
    setPicking(false);
  }
  function onKey(e) { if (state.picking && e.key === "Escape") setPicking(false); }

  function setPicking(on) {
    ensureOverlay();
    state.picking = !!on;
    document.documentElement.style.cursor = on ? "crosshair" : "";
    if (!on) { state.overlay.style.display = "none"; state.label.style.display = "none"; }
    report("picking", { on: !!on });
  }
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKey, true);

  // console / error capture (throttled)
  let count = 0;
  const send = (level, message) => { if (count++ > 200) return; report("console", { level, message: String(message).slice(0, 2000), url: location.href, ts: Date.now() }); };
  for (const level of ["error", "warn"]) {
    const orig = console[level];
    console[level] = (...args) => { try { send(level, args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ")); } catch (e) {} return orig.apply(console, args); };
  }
  window.addEventListener("error", (e) => send("error", (e.message || "") + (e.filename ? ` (${e.filename}:${e.lineno})` : "")));
  window.addEventListener("unhandledrejection", (e) => send("error", "Unhandled rejection: " + (e.reason && (e.reason.stack || e.reason.message || e.reason))));

  window.__vibecoderPreview = { setPicking, describe };
  report("ready", { url: location.href, title: document.title });
})();
