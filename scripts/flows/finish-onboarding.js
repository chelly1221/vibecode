// Step 4: set projects root, go to step 5, take note of summary, click 시작하기, wait for main UI.
const input = [...document.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("C:"));
if (input) vc.setValue(input, "C:\\code");
await vc.sleep(300);
const next = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("다음"));
vc.click(next);
await vc.waitFor(() => document.querySelector("h1")?.textContent === "완료", 10000);
await vc.sleep(400);
const summary = document.body.innerText.slice(document.body.innerText.indexOf("완료\n\n설정 요약"), document.body.innerText.indexOf("이전\n시작하기"));
const start = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().includes("시작하기"));
vc.click(start);
await vc.waitFor(() => !document.body.innerText.includes("vibecode 시작하기"), 15000);
await vc.sleep(1500);
return { summary, main: document.body.innerText.slice(0, 800) };
