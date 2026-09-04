// Click the option whose text is window.__answer in the question card, then submit.
const opt = await vc.waitFor(() => [...document.querySelectorAll("main button, main label, main [role=radio], main [role=checkbox]")].find((el) => el.textContent.trim() === window.__answer || el.textContent.trim().startsWith(window.__answer)), 20000, 500);
vc.click(opt);
await vc.sleep(400);
const submit = [...document.querySelectorAll("main button")].find((b) => /답변 보내기|답변|제출|보내기/.test(b.textContent.trim()) && !b.disabled);
if (!submit) throw new Error("submit button not found: " + [...document.querySelectorAll("main button")].map((b) => b.textContent.trim()).filter(Boolean).slice(-12).join(" | "));
vc.click(submit);
await vc.sleep(1000);
return "answered";
