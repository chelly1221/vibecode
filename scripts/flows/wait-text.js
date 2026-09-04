// Wait until main contains window.__needle; return the surrounding text.
await vc.waitFor(() => (document.querySelector("main")?.innerText ?? "").includes(window.__needle), 240000, 800);
await vc.sleep(800);
return document.querySelector("main")?.innerText.slice(-1500);
