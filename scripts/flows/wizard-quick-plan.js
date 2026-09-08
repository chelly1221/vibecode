// Quick mode: open the wizard, describe the program, let the agent plan, wait for the summary.
// Inputs: window.__desc (description), window.__parent (Windows parent dir).
const openBtn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || b.title || "").includes("새 프로젝트")) || vc.byText("새 프로젝트", "button");
vc.click(openBtn);
const ta = await vc.waitFor(() => document.getElementById("wz-describe"), 10000);
vc.setValue(ta, window.__desc);
const parent = document.getElementById("wz-parent-quick");
vc.setValue(parent, window.__parent);
await vc.sleep(300);
const go = await vc.waitFor(() => [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.includes("만드는 방법 제안받기") && !b.disabled), 5000);
vc.click(go);
await vc.waitFor(() => [...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.includes("이대로 만들기")) || document.body.innerText.includes("AI가 구성을 정하지 못했습니다"), 180000, 1000);
return document.querySelector("[role=dialog]").innerText;
