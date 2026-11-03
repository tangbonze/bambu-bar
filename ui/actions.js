// 面板上的三个按钮（刷新 / 设置 / 退出）在 Tauri 版里必须自己接线。
//
// Electron 版靠 preload 把这些点击转发到主进程；移植到 Tauri 时只搬了渲染层，
// 于是这三个按钮一直是「长得像按钮、点了没反应」——比没有按钮更让人困惑。
(function () {
  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core) return;
  const invoke = tauri.core.invoke;

  const on = (id, fn) => {
    const node = document.getElementById(id);
    if (node) node.addEventListener('click', fn);
  };

  on('btnRefresh', () => invoke('refresh_all'));

  // 先收起面板再开设置窗：面板是点击外部就隐藏的浮层，直接开会和它抢焦点。
  on('btnSettings2', async () => {
    try {
      await invoke('hide_panel');
    } catch (_) {}
    await invoke('open_settings');
  });

  on('btnQuit', () => invoke('quit_app'));
})();
