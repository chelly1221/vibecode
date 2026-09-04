// Click the project button in the sidebar and wait for the git panel to load.
const aside = document.querySelector("aside");
const btn = [...aside.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("vibecode") && b.textContent.includes("tauri-react"));
if (!btn) throw new Error("project button not found");
vc.click(btn);
await vc.sleep(3000);
await vc.waitFor(() => !document.querySelector(".animate-spin"), 30000, 500);
return document.body.innerText.slice(0, 2000);
