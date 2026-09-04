// Stop the running dev server, set an unbuffered demo command, start, wait for the webview to open.
const stop = [...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "중지");
if (stop) { vc.click(stop); await vc.sleep(1500); }
const cmdInput = [...document.querySelectorAll("main input")].find((i) => (i.placeholder || "").includes("dev 서버 명령"));
vc.setValue(cmdInput, "python3 -u -m http.server 8124 --bind 0.0.0.0");
await vc.sleep(200);
vc.click([...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "시작"));
await vc.waitFor(() => [...document.querySelectorAll("main button")].some((b) => b.textContent.trim() === "요소 선택" && !b.disabled), 60000, 500);
await vc.sleep(1500);
const url = [...document.querySelectorAll("main input")].find((i) => (i.placeholder || "").includes("localhost"))?.value;
return "webview open, url=" + url;
