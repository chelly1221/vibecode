// Toggle the files panel and open README.md in the viewer.
const btn = document.querySelector('aside button[aria-label="파일"]') || [...document.querySelectorAll("aside button")].find((b) => (b.getAttribute("aria-label") || "").includes("파일"));
if (!btn) throw new Error("파일 button not found: " + [...document.querySelectorAll("aside button")].map((b) => b.getAttribute("aria-label")).filter(Boolean).join(","));
vc.click(btn);
await vc.waitFor(() => document.body.innerText.includes("README.md"), 20000, 500);
await vc.sleep(600);
window.__filesText = document.body.innerText.slice(0, 900);
const file = [...document.querySelectorAll("button, div, span")].find((el) => el.textContent.trim() === "README.md" && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().height < 40);
vc.click(file);
await vc.waitFor(() => document.querySelector("[role=dialog]") && document.querySelector("[role=dialog] .cm-editor"), 15000, 500);
await vc.sleep(800);
return document.querySelector("[role=dialog]").innerText.slice(0, 400);
