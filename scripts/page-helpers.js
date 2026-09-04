// Page-side helpers injected before automation scripts (evaluated in the WebView).
window.__vc = {
  invoke: (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  // find an element by visible text (exact or includes)
  byText: (text, sel = "button, a, [role=menuitem], [role=option], [role=tab], label, div, span") =>
    [...document.querySelectorAll(sel)].find((el) => el.textContent && el.textContent.trim() === text) ||
    [...document.querySelectorAll(sel)].find((el) => el.textContent && el.textContent.trim().includes(text)),
  click: (el) => {
    if (!el) throw new Error("click: element not found");
    el.scrollIntoView({ block: "center" });
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
  },
  // React-friendly value setter for inputs/textareas
  setValue: (el, value) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  text: () => document.body.innerText,
  waitFor: async (pred, timeout = 15000, step = 200) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const v = pred();
        if (v) return v;
      } catch {}
      await new Promise((r) => setTimeout(r, step));
    }
    throw new Error("waitFor timeout");
  },
};
return "helpers installed";
