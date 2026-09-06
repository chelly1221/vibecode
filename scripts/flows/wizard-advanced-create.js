// Advanced wizard end to end: open the dialog, switch to the six-step form, fill it and press "생성 시작".
// Inputs: window.__name, window.__parent (Windows dir), window.__target (card label, e.g. "Windows"),
//         window.__type (card label, e.g. "스크립트"), window.__stack (stack name substring, e.g. "Python").
if (document.querySelector("[role=dialog]")) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
  await vc.sleep(600);
}
const openBtn = document.querySelector('aside button[aria-label="새 프로젝트"]') || vc.byText("새 프로젝트", "button");
vc.click(openBtn);
await vc.waitFor(() => document.getElementById("wz-describe"), 10000);
const adv = [...document.querySelectorAll("[role=dialog] button")].find((b) => /직접|고급/.test(b.textContent));
if (!adv) throw new Error("no advanced button");
vc.click(adv);
await vc.waitFor(() => document.getElementById("wz-name"), 5000);
vc.setValue(document.getElementById("wz-name"), window.__name);
vc.setValue(document.getElementById("wz-parent"), window.__parent);
await vc.sleep(300);
const nextBtn = () => [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim().startsWith("다음") && !b.disabled);
const pick = (label) => {
  const el = [...document.querySelectorAll("[role=dialog] button, [role=dialog] [role=radio]")].find((e) => e.textContent.trim().startsWith(label));
  if (!el) throw new Error("card not found: " + label);
  vc.click(el);
};
vc.click(await vc.waitFor(nextBtn, 5000)); await vc.sleep(400);
pick(window.__target); await vc.sleep(300);
vc.click(await vc.waitFor(nextBtn, 5000)); await vc.sleep(400);
pick(window.__type); await vc.sleep(300);
vc.click(await vc.waitFor(nextBtn, 5000));
await vc.waitFor(() => [...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.includes(window.__stack)), 30000, 500);
const stackBtn = [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.includes(window.__stack));
vc.click(stackBtn); await vc.sleep(400);
vc.click(await vc.waitFor(nextBtn, 5000)); await vc.sleep(600);
const go = await vc.waitFor(() => [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.includes("생성 시작") && !b.disabled), 5000);
vc.click(go);
await vc.sleep(1500);
return document.querySelector("[role=dialog]").innerText.slice(0, 1500);
