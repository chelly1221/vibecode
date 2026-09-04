// Wait for the tools table to finish loading (no spinners / pulse placeholders), return text.
await vc.waitFor(() => !document.querySelector(".animate-spin") && !document.querySelector(".animate-pulse") && document.body.innerText.includes("claude"), 60000, 500);
await vc.sleep(300);
return document.body.innerText.slice(0, 1500);
