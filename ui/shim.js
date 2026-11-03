// Tauri 适配层：把 popover.js 依赖的 window.bambu（原来由 Electron preload 提供）
// 用 Tauri 的 invoke / event 重新实现，并在这里把「原始报文 → 快照」组装起来。
//
// 为什么要在这里组装，而不是让 Rust 直接给快照：
//   Electron 版的 buildPrinterView 是唯一事实来源（AMS 空槽、双喷头取色、跨天 ETA 等
//   都在里面）。Rust 只负责 IO，字段解释权留在 JS，换框架不换行为。

// ⚠️ 整体包在 IIFE 里：经典脚本共享同一个全局词法作用域，而 popover.js 也声明了
//    strings / locale / snap 等顶层名字——不隔离就会「Identifier already declared」，
//    整个 shim 在解析阶段就直接报废，window.bambu 永远挂不上（面板一片空白）。
(function () {
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const Core = window.BambuCore;

let boot = { locale: 'zh-CN', printers: [], prefs: {}, account: {}, demo: false };
let strings = { table: {}, locale: 'zh-CN' };
const reports = new Map();      // serial → 合并后的报文（Rust 已深合并）
const completion = new Map();   // serial → 完成记忆记录
const stabilizers = new Map();  // serial → StateStabilizer
const errorTables = new Map();  // `${lang}_${代号}` → 官方码表（解析后）
const errorTablePending = new Set(); // 正在取的表，避免并发重复请求
let snapshot = null;
let pendingRender = null;

// 初始化是异步的（要读配置、挂事件），但 popover.js 一加载就会同步取 window.bambu，
// 所以先放一个「排队等就绪」的壳，init 完成后再放行。
let markReady;
const ready = new Promise((r) => { markReady = r; });

const T = (key, params) => Core.t(strings.locale, key, params);

// ── 官方 HMS / 错误码表 ──
//
// 表从 Rust 那边取（那里负责找本地 BambuStudio 的缓存 / 应用包 / GitHub），
// 这里只做「解析 + 查表」——逻辑与 Electron 版共用 src/core/bambu-error-codes.js，
// 同一份文件，不是重写的。
//
// 机型代号 = 序列号前 3 位；语言跟着界面 locale 走。两者任一变化就是另一张表，
// 所以缓存 key 把语言带上。

const hex8 = (n) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

function errorTableKey(serial) {
  const model = Core.errorCodes.modelCodeFromSerial(serial);
  if (!model) return null;
  const lang = Core.errorCodes.langForLocale(strings.locale);
  return `${lang}_${model}`;
}

function tableFor(serial) {
  const key = errorTableKey(serial);
  return key ? (errorTables.get(key) || null) : null;
}

// 取表失败不报错：那张表只是让失败卡片多一句官方中文说明，没有它也能用。
async function ensureErrorTable(serial) {
  const key = errorTableKey(serial);
  if (!key || errorTables.has(key) || errorTablePending.has(key)) return;
  errorTablePending.add(key);
  try {
    const raw = await invoke('error_table', { serial });
    if (!raw) return;
    const lang = key.slice(0, key.indexOf('_'));
    errorTables.set(key, Core.errorCodes.parseErrorTable(JSON.parse(raw), lang));
  } catch (e) {
    console.warn('[error-codes] 取表失败', serial, e);
  } finally {
    errorTablePending.delete(key);
  }
}

// 报文 + 官方码表 → { text, category, hmsTexts }：
//   text      失败主因的一句话（如「耗材用尽，请装入新耗材」）
//   category  粗粒度大类（断料 / 堵头 / 温度…），用于图标与配色
//   hmsTexts  每条 HMS 码的中文说明（面板上悬停可见）
function reasonFor(report, table) {
  if (!report) return null;
  const hmsTexts = {};
  if (table && Array.isArray(report.hms)) {
    for (const h of report.hms) {
      if (!h || !Number.isFinite(h.attr) || !Number.isFinite(h.code)) continue;
      const code = hex8(h.attr) + hex8(h.code);
      const intro = table.deviceHms.get(code);
      if (intro) hmsTexts[code] = intro;
    }
  }
  return {
    text: table ? Core.errorCodes.lookupFailureReason(report, table) : null,
    category: table ? Core.errorCodes.failureCategory(report, table) : null,
    hmsTexts,
  };
}

// 拉全部机器的码表。**不阻塞首屏**——表可能要走网络，面板先出来，
// 拿到码表后再重渲染一次。
async function loadErrorTables() {
  const list = boot.printers || [];
  await Promise.all(list.map((p) => ensureErrorTable(p.serial)));
  scheduleRender();
}

function statusTextOf(state) {
  if (!state) return T('tray.starting');
  const p = state.labelParams || {};
  if (p.finishedAt != null) {
    const sec = Math.max(0, Math.floor((Date.now() - p.finishedAt) / 1000));
    if (sec < 60) return T('label.finishedJustNow');
    if (sec < 3600) return T('label.finishedMinAgo', { m: Math.floor(sec / 60) });
    return T('label.finishedHourAgo', { h: Math.floor(sec / 3600) });
  }
  return T(state.labelKey, p);
}

function viewFor(entry) {
  const report = reports.get(entry.serial) || null;
  let state = report ? Core.resolveState(report) : { stateKey: 'offline', labelKey: 'label.offline', labelParams: {} };

  if (report) {
    // 增量报文会有帧级错位（开印瞬间闪「完成」），稳定器只影响对外显示。
    let stab = stabilizers.get(entry.serial);
    if (!stab) { stab = new Core.StateStabilizer(); stabilizers.set(entry.serial, stab); }
    const observed = stab.observe(state, Date.now());
    state = observed.state || state;

    // 完成记忆：同一任务的完成时刻只记一次，重启后仍能显示「X 分钟前完成」。
    const out = Core.applyCompletionState(report, state, completion.get(entry.serial) || null, Date.now());
    completion.set(entry.serial, out.record);
    state = out.state;
  }

  const view = Core.buildPrinterView({
    entry, report, state, locale: strings.locale, hidden: !!entry.hidden,
    reason: reasonFor(report, tableFor(entry.serial)),
  });
  view.statusText = statusTextOf(state);
  return view;
}

function buildSnapshot() {
  const views = boot.printers.filter((p) => !p.hidden).map(viewFor).filter(Boolean);
  const summary = Core.summarizeViews(views);
  return {
    mode: boot.demo ? 'demo' : 'live',
    locale: strings.locale,
    account: boot.account || {},
    summary,
    printers: views,
    prefs: {
      showTrayPercent: boot.prefs.showTrayPercent !== false,
      panelWidth: boot.prefs.panelWidth || 400,
      maxPanelHeight: Math.max(240, window.screen.availHeight - 140),
    },
    lanCount: boot.printers.filter((p) => p.source === 'lan').length,
    updatedAt: Date.now(),
    emptyReason: views.length
      ? null
      : (boot.printers.length ? 'hidden' : (boot.account && boot.account.loggedIn ? 'no-printers' : 'not-logged-in')),
  };
}

function pushSnapshot() {
  snapshot = buildSnapshot();
  if (typeof window.__onSnapshot === 'function') window.__onSnapshot(snapshot);
}

// 合并节流：报文可能一秒多帧，面板不必跟着重排。
function scheduleRender() {
  if (pendingRender) return;
  pendingRender = setTimeout(() => { pendingRender = null; pushSnapshot(); }, 300);
}

// ── window.bambu：先挂壳，等 init 完成 ──
window.bambu = {
  getSnapshot: async () => { await ready; return snapshot || buildSnapshot(); },
  getStrings: async () => { await ready; return strings; },
  ready: async () => true,
  setHeight: async (h) => { await ready; return invoke('set_panel_height', { height: h }); },
  onState: (cb) => { window.__onSnapshot = cb; },
  onLocale: () => {},
  refreshAll: async () => { await ready; return invoke('refresh_all'); },
  refreshOne: async (serial) => { await ready; return invoke('refresh_one', { serial }); },
  copy: async (text) => { try { await navigator.clipboard.writeText(text); } catch { /* 无剪贴板权限 */ } },
  setHidden: async (serial, hidden) => { await ready; return invoke('set_hidden', { serial, hidden }); },
  rename: async (serial, name) => { await ready; return invoke('rename_printer', { serial, name }); },
  openSettings: async () => { await ready; return invoke('open_settings'); },
  diagnostics: async () => { await ready; return invoke('diagnostics'); },
  quit: async () => { await ready; return invoke('quit_app'); },
  hidePanel: async () => { await ready; return invoke('hide_panel'); },
};

async function init() {
  boot = await invoke('get_bootstrap');
  boot.locale = boot.locale || 'zh-CN';
  strings = Core.bundle(boot.locale);

  await listen('report', (e) => {
    reports.set(e.payload.serial, e.payload.report);
    scheduleRender();
  });
  await listen('bootstrap', (e) => {
    boot = { ...boot, ...e.payload };
    // 清单可能变了（登录成功、加了局域网机器）：补拉新增机器的码表。
    loadErrorTables();
    scheduleRender();
  });

  // 演示模式：用 Electron 版内置假数据跑通 UI，不连网。
  if (boot.demo) {
    boot.printers = boot.printers.length ? boot.printers : Core.demo.demoEntries();
    Core.demo.start(() => {
      for (const serial of Core.demo.serials()) {
        const r = Core.demo.reportFor(serial);
        if (r) reports.set(serial, r);
      }
      scheduleRender();
    });
  }

  markReady();
  scheduleRender();

  // 码表走网络，慢慢来；面板先出来，拿到后自动重渲染。
  loadErrorTables();
}

init().catch((e) => {
  console.error('[shim] 初始化失败', e);
  markReady();
});
})();
