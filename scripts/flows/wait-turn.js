// Wait until the number of turn dividers grows past window.__dividers (default 0); returns main text tail.
const count = () => (document.querySelector("main")?.innerText.match(/\d+(\.\d+)?s · ↑/g) || []).length;
const base = window.__dividers ?? 0;
await vc.waitFor(() => count() > base, 240000, 1000);
window.__dividers = count();
await vc.sleep(1500);
return document.querySelector("main")?.innerText.slice(-1800);
