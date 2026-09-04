// Wait until no spinner/pulse is visible, then return page text.
await vc.sleep(800);
await vc.waitFor(() => !document.querySelector(".animate-spin") && !document.querySelector(".animate-pulse"), 60000, 500);
await vc.sleep(300);
return document.body.innerText.slice(0, 1500);
