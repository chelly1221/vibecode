// Click the footer "다음" button and wait for the heading to change.
const before = document.querySelector("h1")?.textContent;
const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("다음"));
if (!btn) throw new Error("no 다음 button");
vc.click(btn);
await vc.waitFor(() => document.querySelector("h1")?.textContent !== before, 15000);
await vc.sleep(500);
return document.querySelector("h1")?.textContent;
