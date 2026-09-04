// Close any open dialog, open the wizard, fill step 1, choose Windows + 데스크톱 앱, reach step 4 (stacks).
if (document.querySelector("[role=dialog]")) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
  await vc.sleep(600);
}
vc.click(document.querySelector('aside button[aria-label="새 프로젝트"]'));
const dialog = await vc.waitFor(() => document.querySelector("[role=dialog]"), 10000);
await vc.sleep(500);
vc.setValue(dialog.querySelector("input"), "demo-app");
await vc.sleep(200);
const nextBtn = () => [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim().startsWith("다음"));
const pick = (label) => {
  const el = [...document.querySelectorAll("[role=dialog] button, [role=dialog] [role=radio], [role=dialog] div")].find((e) => e.textContent.trim().startsWith(label) && e.getBoundingClientRect().height > 30 && e.getBoundingClientRect().height < 160);
  if (!el) throw new Error("card not found: " + label);
  vc.click(el);
};
vc.click(nextBtn()); await vc.sleep(500);
pick("Windows"); await vc.sleep(300);
vc.click(nextBtn()); await vc.sleep(500);
pick("데스크톱 앱"); await vc.sleep(300);
vc.click(nextBtn()); await vc.sleep(3000);
await vc.waitFor(() => !document.querySelector("[role=dialog] .animate-spin"), 30000, 500);
return document.querySelector("[role=dialog]").innerText.slice(0, 1500);
