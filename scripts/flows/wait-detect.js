// Wait until onboarding detection finished (추천 badge visible) and return the card texts.
await vc.waitFor(() => document.body.innerText.includes("추천") && !document.querySelector(".animate-pulse"), 40000, 500);
return document.body.innerText.slice(0, 1200);
