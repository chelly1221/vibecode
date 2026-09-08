// Close dialogs, select the project, open the git panel's file list and hover it so scrollbars show.
if (document.querySelector("[role=dialog]")) { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })); await vc.sleep(500); }
const aside = document.querySelector("aside");
const pbtn = [...aside.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("vibecode"));
if (pbtn) vc.click(pbtn);
await vc.sleep(3000);
// hover the git panel scroll container (right aside) so the thumb becomes visible
const right = [...document.querySelectorAll("aside")].pop();
const scroller = [...right.querySelectorAll("*")].find((el) => el.scrollHeight > el.clientHeight + 20 && getComputedStyle(el).overflowY !== "visible");
if (scroller) {
  scroller.scrollTop = 40;
  scroller.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  scroller.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
}
await vc.sleep(600);
return scroller ? `${scroller.tagName}.${scroller.className.slice(0, 60)} sh=${scroller.scrollHeight} ch=${scroller.clientHeight}` : "no scroller";
