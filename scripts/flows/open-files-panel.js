// Toggle the files panel and open README.md in the viewer.
vc.click(document.querySelector('button[aria-label="추가 도구"]'));
const btn = await vc.waitFor(() => vc.byText("파일 목록 열기", '[role="menuitem"]'));
vc.click(btn);
await vc.waitFor(() => document.body.innerText.includes("README.md"), 20000, 500);
await vc.sleep(600);
window.__filesText = document.body.innerText.slice(0, 900);
const file = [...document.querySelectorAll("button, div, span")].find((el) => el.textContent.trim() === "README.md" && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().height < 40);
vc.click(file);
await vc.waitFor(() => document.querySelector("[role=dialog]") && document.querySelector("[role=dialog] .cm-editor"), 15000, 500);
await vc.sleep(800);
return document.querySelector("[role=dialog]").innerText.slice(0, 400);
