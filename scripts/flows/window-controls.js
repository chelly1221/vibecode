// Toggle maximize via the title bar button and report viewport sizes.
const before = [window.innerWidth, window.innerHeight];
const max = document.querySelector('header button[aria-label="최대화"], header button[aria-label="이전 크기로"]');
vc.click(max);
await vc.sleep(1200);
const after = [window.innerWidth, window.innerHeight, max.getAttribute("aria-label")];
vc.click(document.querySelector('header button[aria-label="최대화"], header button[aria-label="이전 크기로"]'));
await vc.sleep(1200);
const restored = [window.innerWidth, window.innerHeight];
return { before, afterToggle: after, restored };
