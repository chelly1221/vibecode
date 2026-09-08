// Verify StrictMode cannot start two native login flows for one panel.
// IPC is stubbed: no browser or native login process is opened.
const loaded = (path) => performance.getEntriesByType('resource').map(e => e.name).filter(url => new URL(url).pathname === path).at(-1) ?? path;
const reactModule = await import(loaded('/node_modules/.vite/deps/react.js'));
const React = reactModule.default ?? reactModule;
const domModule = await import(loaded('/node_modules/.vite/deps/react-dom_client.js'));
const { createRoot } = domModule.default ?? domModule;
const { LoginPanel } = await import(loaded('/src/features/onboarding/LoginPanel.tsx'));
const { ipc } = await import(loaded('/src/lib/ipc.ts'));
const saved = { start: ipc.tools.loginStart, cancel: ipc.tools.loginCancel };
let starts = 0, cancels = 0;
const host = document.createElement('div');
host.hidden = true;
document.body.append(host);
const root = createRoot(host);
try {
  ipc.tools.loginStart = async (_provider, onEvent) => { starts++; onEvent({ type: 'started' }); return '__login_lifecycle_test__'; };
  ipc.tools.loginCancel = async id => { if (id !== '__login_lifecycle_test__') throw Error('unexpected login cancellation'); cancels++; };
  root.render(React.createElement(React.StrictMode, null, React.createElement(LoginPanel, { provider: 'claude', accountId: '__test__', onFinished: () => {}, onClose: () => {} })));
  await vc.waitFor(() => starts > 0);
  await vc.sleep(150);
  if (starts !== 1) throw Error(`one panel started ${starts} login flows`);
  root.unmount();
  await vc.sleep(100);
  if (cancels !== 1) throw Error(`closing panel cancelled ${cancels} flows`);
  return { strictModeStarts: starts, unmountCancels: cancels };
} finally {
  root.unmount();
  host.remove();
  ipc.tools.loginStart = saved.start;
  ipc.tools.loginCancel = saved.cancel;
}
