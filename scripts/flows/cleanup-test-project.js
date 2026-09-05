// Test cleanup: interrupt/close the live session of the project under window.__parent, then remove the project.
const projects = await vc.invoke("projects_list");
const victims = projects.filter((p) => p.path.toLowerCase().startsWith(String(window.__parent).toLowerCase()));
const out = [];
for (const p of victims) {
  const sessions = await vc.invoke("sessions_list", { projectId: p.id });
  for (const s of sessions) {
    try { await vc.invoke("session_interrupt", { sessionId: s.id }); } catch {}
    try { await vc.invoke("session_close", { sessionId: s.id }); } catch {}
  }
  await vc.invoke("projects_remove", { id: p.id });
  out.push(`${p.name} (${p.path}) removed, sessions: ${sessions.length}`);
}
return out;
