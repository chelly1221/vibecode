// Stop the running dev server, set an unbuffered demo command, start, wait for the webview to open.
const stop = [...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "멈추기");
if (stop) { vc.click(stop); await vc.sleep(1500); }
vc.click(vc.byText("실행 설정", "button"));
const cmdInput = await vc.waitFor(() => document.querySelector('input[aria-label="미리보기 시작 명령"]'));
vc.setValue(cmdInput, "python3 -u -m http.server 8124 --bind 0.0.0.0");
await vc.sleep(200);
document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await vc.sleep(200);
vc.click([...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "미리보기 시작"));
await vc.waitFor(() => [...document.querySelectorAll("main button")].some((b) => b.textContent.trim() === "화면 선택" && !b.disabled), 60000, 500);
await vc.sleep(1500);
const url = [...document.querySelectorAll("main input")].find((i) => (i.placeholder || "").includes("localhost"))?.value;
return "webview open, url=" + url;
