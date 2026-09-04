// Open a new terminal tab in the project dir, paste a command, and read the xterm rows.
const newBtn = document.querySelector('button[aria-label="새 터미널"]') || [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "새 터미널");
vc.click(newBtn);
const ta = await vc.waitFor(() => document.querySelector(".xterm-helper-textarea"), 15000);
await vc.sleep(3500);
ta.focus();
const dt = new DataTransfer();
dt.setData("text/plain", "echo VIBE_$((1+1)) && uname -s && pwd\n");
ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
await vc.sleep(3500);
const rows = [...document.querySelectorAll(".xterm-rows > div")].map((r) => r.textContent.replace(/\u00a0/g, " ").trimEnd()).filter(Boolean);
return rows.slice(-10);
