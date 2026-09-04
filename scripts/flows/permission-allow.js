const allowBtn = [...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "허용");
if (!allowBtn) throw new Error("no 허용 button");
const dividersBefore = (document.querySelector("main")?.innerText.match(/\d+(\.\d+)?s · \$/g) || []).length;
vc.click(allowBtn);
await vc.waitFor(() => (document.querySelector("main")?.innerText.match(/\d+(\.\d+)?s · \$/g) || []).length > dividersBefore, 120000, 500);
await vc.sleep(1500);
return document.querySelector("main")?.innerText.slice(-900);
