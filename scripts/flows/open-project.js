// Register C:\code\vibecode as a project through IPC, then reload so the sidebar picks it up.
const rec = await vc.invoke("projects_open", { path: "C:\\code\\vibecode" });
setTimeout(() => location.reload(), 200);
return rec;
