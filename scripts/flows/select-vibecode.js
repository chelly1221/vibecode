// Select the "vibecode" project (not the user's "test" project) and wait for the git panel.
if (document.querySelector("[role=dialog]")) { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })); await vc.sleep(400); }
await vc.waitFor(() => document.querySelector("aside"), 30000, 500);
const aside = document.querySelector("aside");
const btn = [...aside.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("vibecode") && b.textContent.includes("tauri-react"));
if (!btn) throw new Error("vibecode project not found");
vc.click(btn);
await vc.sleep(2000);
return document.querySelector("aside").innerText.slice(0, 300);
