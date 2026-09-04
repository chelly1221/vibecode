// Close the wizard (Escape), then open settings.
document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
await vc.sleep(700);
const confirm = [...document.querySelectorAll("button")].find((b) => /닫기|확인|나가기/.test(b.textContent) && b.closest("[role=alertdialog],[role=dialog]"));
if (document.querySelector("[role=dialog],[role=alertdialog]") && confirm) { vc.click(confirm); await vc.sleep(500); }
const settings = document.querySelector('aside button[aria-label="설정"]');
vc.click(settings);
await vc.waitFor(() => document.querySelector("[role=dialog]"), 10000);
await vc.sleep(2500);
return document.querySelector("[role=dialog]").innerText.slice(0, 800);
