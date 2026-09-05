// Quick mode: press "이대로 만들기" and wait until the dialog closes (first session started) or fails.
const go = await vc.waitFor(() => [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.includes("이대로 만들기")), 5000);
vc.click(go);
await vc.waitFor(() => !document.querySelector("[role=dialog]") || document.body.innerText.includes("생성에 실패했습니다") || document.body.innerText.includes("자동으로 시작하지 못했습니다"), 300000, 1000);
const dlg = document.querySelector("[role=dialog]");
return dlg ? "DIALOG STILL OPEN:\n" + dlg.innerText : "closed; main:\n" + document.querySelector("main").innerText.slice(0, 1500);
