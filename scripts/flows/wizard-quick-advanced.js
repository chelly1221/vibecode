// After a quick-mode plan: switch to the advanced wizard and report the prefilled form.
const btn = await vc.waitFor(() => [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.includes("바꾸기")), 5000);
vc.click(btn);
await vc.waitFor(() => document.getElementById("wz-name"), 5000);
const val = (id) => document.getElementById(id)?.value;
const steps = [...document.querySelectorAll("[role=dialog] ol button")].map((b) => `${b.textContent.trim()}${b.disabled ? "(잠김)" : ""}`);
return { name: val("wz-name"), dir: val("wz-dir"), parent: val("wz-parent"), desc: val("wz-desc"), steps };
