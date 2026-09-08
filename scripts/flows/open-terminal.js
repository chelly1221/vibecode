// Select the project, open the terminal panel, wait for the prompt.
const aside = document.querySelector("aside");
const pbtn = [...aside.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("vibecode"));
if (pbtn) vc.click(pbtn);
await vc.sleep(800);
vc.click(document.querySelector('button[aria-label="추가 도구"]'));
const term = await vc.waitFor(() => vc.byText("개발자 터미널 열기", '[role="menuitem"]'));
vc.click(term);
await vc.waitFor(() => document.querySelector(".xterm"), 15000);
await vc.sleep(5000);
return document.body.innerText.slice(-600);
