// Type a command into the active xterm and wait for output.
const el = document.querySelector(".xterm-helper-textarea");
if (!el) throw new Error("no xterm textarea");
el.focus();
const send = (data) => el.dispatchEvent(new InputEvent("input", { data, inputType: "insertText", bubbles: true }));
// xterm listens to keydown/keypress + textarea input; use the store helper if available, else dispatch keys
for (const ch of "echo VIBE_$((1+1)) && uname -a\n") {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: ch === "\n" ? "Enter" : ch, code: ch === "\n" ? "Enter" : "Key" + ch.toUpperCase(), keyCode: ch === "\n" ? 13 : ch.charCodeAt(0), bubbles: true }));
  if (ch !== "\n") el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, charCode: ch.charCodeAt(0), keyCode: ch.charCodeAt(0), bubbles: true }));
}
await vc.sleep(4000);
return [...document.querextAll?.(".xterm-rows > div") ?? document.querySelectorAll(".xterm-rows > div")].map((r) => r.textContent.trimEnd()).filter(Boolean).slice(-12);
