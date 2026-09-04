// Open the new-session dialog.
const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().includes("새 세션"));
if (!btn) throw new Error("새 세션 button not found");
vc.click(btn);
await vc.waitFor(() => document.querySelector("[role=dialog]"), 10000);
await vc.sleep(1500);
return document.querySelector("[role=dialog]").innerText;
