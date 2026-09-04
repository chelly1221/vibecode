// Open settings → 실행 환경 tab, wait for the managed card status, return its text.
if (document.querySelector("[role=dialog]")) { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })); await vc.sleep(500); }
await vc.waitFor(() => document.querySelector('aside button[aria-label="설정"]'), 30000, 500);
vc.click(document.querySelector('aside button[aria-label="설정"]'));
await vc.waitFor(() => document.querySelector("[role=dialog]"), 10000);
const tab = [...document.querySelectorAll('[role=dialog] [role=tab]')].find((t) => t.textContent.trim() === "실행 환경");
vc.click(tab);
await vc.sleep(1000);
await vc.waitFor(() => document.body.innerText.includes("Vibecoder 전용 환경") && !document.body.innerText.includes("WSL 상태 확인 중"), 30000, 500);
await vc.sleep(800);
return document.querySelector("[role=dialog]").innerText.slice(0, 1200);
