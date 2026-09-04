// Set theme via IPC (window.__theme) and reload.
const s = await vc.invoke("settings_get");
await vc.invoke("settings_set", { settings: { ...s, theme: window.__theme } });
setTimeout(() => location.reload(), 200);
return "theme set";
