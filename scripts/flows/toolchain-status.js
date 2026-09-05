// Windows toolchain detection through the IPC (all tools + the tauri stack subset).
const all = await vc.invoke("toolchain_status", { stackId: null });
const tauri = await vc.invoke("toolchain_status", { stackId: "tauri-react" });
return { all: all.map((t) => `${t.name}: ${t.found ? "found " + (t.version || "") + " @ " + t.path : "missing"}`), tauri: tauri.map((t) => t.name) };
