// During/after creation: report the automatic install card (bar position, per-tool rows) and the step list.
const card = document.querySelector("[data-testid=install-progress]");
const bar = card?.querySelector("[data-slot=progress-indicator]");
return {
  card: card ? card.innerText : null,
  bar: bar ? bar.style.transform : null,
  steps: [...document.querySelectorAll("[role=dialog] ol li")].map((li) => li.innerText),
};
