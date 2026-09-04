// Select the project, open the terminal panel, wait for the prompt.
const aside = document.querySelector("aside");
const pbtn = [...aside.querySelectorAll("button")].find((b) => b.textContent.includes("tauri-react"));
if (pbtn) vc.click(pbtn);
await vc.sleep(800);
const term = document.querySelector('button[aria-label="터미널"]') || [...document.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "").includes("터미널"));
vc.click(term);
await vc.waitFor(() => document.querySelector(".xterm"), 15000);
await vc.sleep(5000);
return document.body.innerText.slice(-600);
