// Open 새 대화 → 시작 → send the prompt stored in window.__prompt; wait for the turn to end (a divider appears).
const nb = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().includes("새 대화"));
vc.click(nb);
const dialog = await vc.waitFor(() => document.querySelector("[role=dialog]"), 10000);
await vc.sleep(800);
vc.click([...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "대화 시작"));
await vc.waitFor(() => !document.querySelector("[role=dialog]"), 15000);
const ta = await vc.waitFor(() => document.querySelector("main textarea"), 30000);
await vc.sleep(3000);
vc.setValue(ta, window.__prompt);
ta.focus();
ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
return "sent";
