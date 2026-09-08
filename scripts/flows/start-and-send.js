// Click 시작 in the new-session dialog, wait for the composer, send a prompt, wait for the reply.
const dialog = document.querySelector("[role=dialog]");
const start = [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "대화 시작");
vc.click(start);
await vc.waitFor(() => !document.querySelector("[role=dialog]"), 15000);
const ta = await vc.waitFor(() => document.querySelector("main textarea"), 30000);
// wait for init (header shows model) — give the WSL spawn a few seconds
await vc.sleep(4000);
const headerBefore = document.querySelector("main")?.innerText.slice(0, 400);
vc.setValue(ta, "Reply with exactly: pong");
ta.focus();
ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
await vc.waitFor(() => /pong/i.test(document.querySelector("main")?.innerText.replace("Reply with exactly: pong", "")), 90000, 500);
await vc.sleep(2500);
return { headerBefore, main: document.querySelector("main")?.innerText.slice(0, 1500) };
