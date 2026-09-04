// Poll until provisioning finished (done or failed); return status + last log lines.
const text = () => document.querySelector("[role=dialog]")?.innerText ?? "";
await vc.waitFor(() => /준비되었습니다|다시 시도|환경 준비 실패/.test(text()), 25 * 60 * 1000, 3000);
await vc.sleep(1000);
const pre = document.querySelector("[role=dialog] pre");
return { tail: (pre?.textContent ?? "").split("\n").slice(-30).join("\n"), head: text().slice(0, 700) };
