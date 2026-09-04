// Open the demo URL in the pane, select a session (composer needed), arm the element picker.
const urlInput = [...document.querySelectorAll("main input")].find((i) => (i.placeholder || "").includes("localhost"));
vc.setValue(urlInput, "http://localhost:8123/");
await vc.sleep(200);
vc.click([...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "열기"));
await vc.sleep(2500);
const sess = [...document.querySelectorAll("aside button")].find((b) => b.textContent.includes("Reply with exactly"));
if (!sess) throw new Error("session button not found");
vc.click(sess);
await vc.waitFor(() => document.querySelector("main textarea"), 15000, 300);
await vc.sleep(1500);
const pick = [...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "요소 선택");
vc.click(pick);
await vc.sleep(800);
return "armed; textarea present";
