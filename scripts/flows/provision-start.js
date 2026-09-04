// Click "환경 준비" inside the managed card (settings dialog must be open on 실행 환경 tab).
const btn = [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.includes("환경 준비") || b.textContent.includes("도구 다시 설치"));
if (!btn) throw new Error("환경 준비 button not found");
vc.click(btn);
await vc.sleep(1500);
return document.querySelector("[role=dialog]").innerText.slice(0, 600);
