// Open the UI preview pane, start a demo dev server (python http.server prints a URL), wait for the
// child webview to open, then toggle element picking. Returns pane text.
if (document.querySelector("[role=dialog]")) { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })); await vc.sleep(400); }
const aside = document.querySelector("aside");
const pbtn = [...aside.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("vibecode"));
if (pbtn) { vc.click(pbtn); await vc.sleep(1500); }
const toggle = document.querySelector('header button[aria-label="미리보기"]');
if (!toggle) throw new Error("UI 미리보기 button not found");
if (toggle.getAttribute("aria-pressed") !== "true") vc.click(toggle);
vc.click(vc.byText("실행 설정", "button"));
const cmdInput = await vc.waitFor(() => document.querySelector('input[aria-label="미리보기 시작 명령"]'));
vc.setValue(cmdInput, window.__previewCmd || "python3 -m http.server 8124 --bind 0.0.0.0");
await vc.sleep(200);
document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await vc.sleep(200);
const startBtn = [...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "미리보기 시작");
vc.click(startBtn);
await vc.waitFor(() => [...document.querySelectorAll("main button")].some((b) => b.textContent.trim() === "화면 선택" && !b.disabled), 60000, 500);
await vc.sleep(1500);
return document.querySelector("main").innerText.slice(0, 500);
