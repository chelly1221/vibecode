// Ask Claude to run a shell command that acceptEdits does NOT auto-approve; wait for the 허용 button.
const ta = document.querySelector("main textarea");
vc.setValue(ta, "Using the Bash tool, run exactly this command and nothing else: python3 -c \"print('permission-test-ok')\"");
ta.focus();
ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
await vc.waitFor(() => [...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "허용"), 90000, 300);
await vc.sleep(600);
return document.querySelector("main")?.innerText.slice(-700);
