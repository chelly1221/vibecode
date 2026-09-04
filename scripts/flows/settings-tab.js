// Open settings and switch to the tab named window.__tab; return dialog text.
if (document.querySelector("[role=dialog]")) { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })); await vc.sleep(500); }
vc.click(document.querySelector('aside button[aria-label="설정"]'));
await vc.waitFor(() => document.querySelector("[role=dialog]"), 10000);
const tab = [...document.querySelectorAll('[role=dialog] [role=tab]')].find((t) => t.textContent.trim() === window.__tab);
if (!tab) throw new Error("tab not found");
vc.click(tab);
await vc.sleep(2500);
return document.querySelector("[role=dialog]").innerText.slice(0, 900);
