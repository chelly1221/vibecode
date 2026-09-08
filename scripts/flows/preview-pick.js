// Open the demo URL in the pane, select a session (composer needed), arm the element picker.
vc.click(vc.byText("실행 설정", "button"));
const urlInput = await vc.waitFor(() => document.querySelector('input[aria-label="미리보기 주소"]'));
vc.setValue(urlInput, "http://localhost:8123/");
await vc.sleep(200);
vc.click(vc.byText("이 주소 열기", "button"));
await vc.sleep(2500);
document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await vc.sleep(200);
const sess = [...document.querySelectorAll("aside button")].find((b) => b.textContent.includes("Reply with exactly"));
if (!sess) throw new Error("session button not found");
vc.click(sess);
await vc.waitFor(() => document.querySelector("main textarea"), 15000, 300);
await vc.sleep(1500);
const pick = [...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "화면 선택");
vc.click(pick);
await vc.sleep(800);
return "armed; textarea present";
