// 弹出面板渲染层。零框架：只做「把快照铺成卡片」这一件事。
//
// 卡片节点按 serial 复用（不整表重建），否则打印中每秒一帧的重推会把鼠标悬停中的
// 操作条重建掉、点击丢失。结构固定的行常驻，靠 hidden 切换；只有 AMS 槽位 / HMS 码
// 这类小容器每次重建（里面没有可交互元素）。

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const show = (n, on) => { if (n) n.hidden = !on; };

// 颜色亮度（sRGB 近似）。用来判断「耗材色太浅、当进度条填充会看不见」。
function luma(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255; const g = (n >> 8) & 255; const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

let strings = {};
let locale = 'zh-CN';
let snap = null;
const cards = new Map(); // serial → { root, q, expanded }

function applyStaticText() {
  document.getElementById('btnRefresh').title = t('pop.refresh');
  document.getElementById('btnSettings2').textContent = t('pop.settings');
  document.getElementById('btnQuit').textContent = t('pop.quit');
  document.getElementById('brandName').textContent = t('app.name');
}

function t(key, params) {
  let s = strings[key];
  if (s == null) s = key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return s;
}

function fmtTemp(cur, tar) {
  if (cur == null) return null;
  if (tar != null && tar > 0) return `${cur}/${tar}°`;
  return `${cur}°`;
}

// ── 摘要文案 ──
function summaryText(s) {
  if (!s.total) return t('pop.summary.none');
  const active = s.printing + s.paused + s.preparing;
  if (!active) {
    if (s.failed) return t('pop.summary.mixed', { n: s.total, active: s.failed });
    return t('pop.summary.idle', { n: s.total });
  }
  if (s.printing === s.total) return t('pop.summary.printing', { n: s.total, printing: s.printing });
  return t('pop.summary.mixed', { n: s.total, active });
}

// ── 单张卡片骨架（只建一次） ──
function cardFor(v) {
  let entry = cards.get(v.serial);
  if (entry) return entry;

  const root = el('article', 'card');
  const q = {};

  const head = el('div', 'card-head');
  q.dot = el('span', 'dot');
  q.name = el('span', 'card-name');
  q.model = el('span', 'chip');
  q.src = el('span', 'chip');
  q.status = el('span', 'card-status');
  head.append(q.dot, q.name, q.model, q.src, q.status);

  const prog = el('div', 'progress');
  q.bar = el('i');
  prog.append(q.bar);

  q.meta = el('div', 'meta');
  q.ams = el('div', 'ams');
  q.err = el('div', 'err');
  q.job = el('div', 'job');
  q.actions = el('div', 'card-actions');
  q.detail = el('div', 'detail');
  q.detail.hidden = true;

  const mk = (label, fn, danger) => {
    const b = el('button', 'mini-btn' + (danger ? ' danger' : ''), label);
    b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
    return b;
  };
  q.btnDetail = mk(t('card.detail'), () => toggleDetail(v.serial));
  q.btnCopy = mk(t('card.copy'), () => copyStatus(v.serial));
  q.btnPull = mk(t('card.pull'), () => { window.bambu.refreshOne(v.serial); flash(t('pop.refresh.done')); });
  q.btnHide = mk(t('card.hide'), () => { window.bambu.setHidden(v.serial, true); });
  q.actions.append(q.btnDetail, q.btnCopy, q.btnPull, q.btnHide);

  // 操作条常驻在卡片最底部（流内、始终可见）：
  //  · 不做悬停显示 —— 悬停一旦改变高度，面板就得改窗口尺寸，鼠标扫过就会抖；
  //  · 放在最后一行，展开的详情块插在它上面，按钮始终是卡片的页脚。
  root.append(head, prog, q.meta, q.ams, q.err, q.job, q.detail, q.actions);
  entry = { root, q, expanded: false };
  cards.set(v.serial, entry);
  return entry;
}

function toggleDetail(serial) {
  const entry = cards.get(serial);
  if (!entry) return;
  entry.expanded = !entry.expanded;
  entry.q.detail.hidden = !entry.expanded;
  entry.q.btnDetail.textContent = t(entry.expanded ? 'card.detail.hide' : 'card.detail');
  entry.root.classList.toggle('expanded', entry.expanded);
  if (entry.expanded) renderDetail(entry, snap && snap.printers.find((x) => x.serial === serial));
  measure();
}

function renderDetail(entry, v) {
  if (!v) return;
  const d = entry.q.detail;
  d.replaceChildren();
  const rows = [];
  const push = (k, val) => { if (val != null && val !== '') rows.push([k, val]); };
  push(t('card.serial'), v.serial);
  push(t('card.source.' + (v.source || 'cloud')), v.host || null);
  push(t('card.job'), v.job);
  if (v.nozzle && v.nozzle.diameter) {
    const nt = v.nozzle.type
      ? (strings['nozzle.' + v.nozzle.type] ? t('nozzle.' + v.nozzle.type) : v.nozzle.type)
      : null;
    push(t('card.nozzleType'), `${v.nozzle.diameter} mm${nt ? ' · ' + nt : ''}`);
  }
  if (v.wifi != null) push(t('card.wifi'), `${v.wifi} dBm`);
  const fans = [];
  if (v.fans.part != null) fans.push(`${t('card.fan.part')} ${v.fans.part}%`);
  if (v.fans.aux != null) fans.push(`${t('card.fan.aux')} ${v.fans.aux}%`);
  if (v.fans.chamber != null) fans.push(`${t('card.fan.chamber')} ${v.fans.chamber}%`);
  if (fans.length) push(t('card.fan'), fans.join(' · '));
  if (v.light) push(t('card.light'), v.light === 'on' ? t('card.light.on') : t('card.light.off'));
  if (v.doorOpen) push(t('card.door'), '—');
  for (const [k, val] of rows) {
    const row = el('div');
    row.append(el('span', 'k', k), el('span', 'v', val));
    d.append(row);
  }
  if (!rows.length) d.append(el('div', 'v', '—'));
}

function copyStatus(serial) {
  const v = snap && snap.printers.find((x) => x.serial === serial);
  if (!v) return;
  const lines = [`${v.name} (${[v.model, v.serial].filter(Boolean).join(' · ')})`, `${t('tray.statusLine', { status: v.statusText })}`];
  const m = [];
  if (v.progress.percent != null && v.statusClass === 'printing') m.push(`${v.progress.percent}%`);
  if (v.progress.layer != null && v.progress.total > 0) m.push(t('card.layer', { layer: v.progress.layer, total: v.progress.total }));
  if (v.progress.remainText) m.push(t('card.remain', { time: v.progress.remainText }));
  if (v.progress.etaText) m.push(t('card.eta', { time: v.progress.etaText + (v.progress.etaDayOffset || '') }));
  if (m.length) lines.push(m.join(' · '));
  const th = [];
  const nt = fmtTemp(v.temps.nozzleTemp, v.temps.targetNozzleTemp);
  const bt = fmtTemp(v.temps.bedTemp, v.temps.targetBedTemp);
  if (nt) th.push(`${t('card.nozzle')} ${nt}`);
  if (bt) th.push(`${t('card.bed')} ${bt}`);
  if (v.temps.chamberTemp != null) th.push(`${t('card.chamber')} ${v.temps.chamberTemp}°`);
  if (th.length) lines.push(th.join(' · '));
  if (v.job) lines.push(`${t('card.job')}: ${v.job}`);
  if (v.hms && v.hms.length) lines.push(`HMS: ${v.hms.map((h) => h.code).join(', ')}`);
  window.bambu.copy(lines.join('\n'));
  flash(t('card.copied'));
}

let toastEl = null;
let toastTimer = null;
function flash(msg) {
  if (!toastEl) {
    toastEl = el('div', 'toast');
    document.body.append(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1400);
}

// ── 更新一张卡片 ──
function updateCard(v) {
  const { root, q } = cardFor(v);

  root.className = `card status--${v.statusClass || 'idle'}`;
  q.name.textContent = v.name;
  q.model.textContent = v.model || '';
  q.model.hidden = !v.model;
  const srcKey = 'card.source.' + (v.source || 'cloud');
  q.src.textContent = t(srcKey);
  q.src.className = 'chip' + (v.source !== 'cloud' ? ' chip--lan' : '');
  q.status.textContent = v.statusText || '';

  // 进度条：打印中显示百分比；暂停/失败保留进度（用户想知道停在哪）。
  const showBar = Number.isFinite(v.progress.percent) && ['printing', 'paused', 'failed', 'finished'].includes(v.statusClass);
  show(q.bar.parentElement, showBar);
  if (showBar) {
    q.bar.style.width = `${Math.max(1, Math.min(100, v.progress.percent))}%`;
    // 打印中直接用耗材颜色填充（白料也看得见 —— 加了描边）
    if (v.statusClass === 'printing' && v.filament && v.filament.current && luma(v.filament.current) < 0.82) {
      q.bar.style.background = v.filament.current;
      q.bar.classList.add('fil');
    } else {
      q.bar.style.background = '';
      q.bar.classList.remove('fil');
    }
  }

  // 指标行
  const parts = [];
  const add = (text) => { if (text) parts.push(text); };
  const p = v.progress;
  const active = ['printing', 'paused', 'prepare'].includes(v.stateKey) || v.stateKey === 'changing_filament'
    || /^printing_/.test(v.stateKey || '');
  if (active && p.layer != null && p.total > 0) add(t('card.layer', { layer: p.layer, total: p.total }));
  if (active && p.remainText) add(t('card.remain', { time: p.remainText }));
  if (active && p.etaText) {
    add(p.etaDayOffset ? t('card.etaDay', { time: p.etaText, d: p.etaDayOffset }) : t('card.eta', { time: p.etaText }));
  }
  const nt = fmtTemp(v.temps.nozzleTemp, v.temps.targetNozzleTemp);
  const bt = fmtTemp(v.temps.bedTemp, v.temps.targetBedTemp);
  if (nt) add(`${t('card.nozzle')} ${nt}`);
  if (bt) add(`${t('card.bed')} ${bt}`);
  // 腔温：只有带腔温控制器的机型才有值（判定在 printer-view.js 的 resolveChamberTemp），
  // 所以这里不再额外要求 > 0 —— 冬天在冷库里开机，腔温本来就可能是负数。
  if (v.temps.chamberTemp != null) add(`${t('card.chamber')} ${v.temps.chamberTemp}°`);
  if (v.speed && v.speed.level) add(`${t('speed.' + v.speed.level)}${v.speed.mag ? ' ' + v.speed.mag + '%' : ''}`);
  // 单段文本而非多个 flex 子项：换行时分隔点留在上一行末尾，不会出现行首「·」。
  q.meta.textContent = parts.join('  ·  ');
  show(q.meta, parts.length > 0);

  // AMS / 外置料盘：两个标签各管一段，有则亮、无则灰。
  // 早前只有一个「AMS」标签，所有料盘槽都挂在它后面 —— 无 AMS 的机器（A1 mini 这类
  // 只接外挂料盘）于是被画成「AMS：一个白圈」，读起来像 AMS 里装着一卷料。
  // 现在按来源分标签：AMS 亮起=这台的 AMS 有槽位；外置亮起=接着外挂料盘。
  q.ams.replaceChildren();
  const f = v.filament || {};
  const units = f.units || [];
  const amsSlots = units.reduce((n, u) => n + u.slots.length, 0);
  const hasExt = !!f.external;
  if (amsSlots || hasExt) {
    const amsTag = el('span', 'ams-tag' + (amsSlots ? ' on' : ''), t('card.ams'));
    amsTag.title = amsSlots ? t('card.slots', { n: amsSlots }) : t('card.amsOff');
    q.ams.append(amsTag);
    units.forEach((u, ui) => {
      if (ui > 0) q.ams.append(el('span', 'ams-sep'));
      for (const s of u.slots) {
        const d = el('span', 'slot' + (s.color ? '' : ' unknown') + (s.active ? ' active' : ''));
        if (s.color) d.style.setProperty('--c', s.color);
        d.title = [s.type, s.remain >= 0 ? `${s.remain}%` : null].filter(Boolean).join(' · ') || '—';
        q.ams.append(d);
      }
    });

    q.ams.append(el('span', 'ams-sep'));
    const extTag = el('span', 'ams-tag' + (hasExt ? ' on' : ''), t('card.ext'));
    extTag.title = hasExt ? t('card.amsExt') : t('card.extOff');
    q.ams.append(extTag);
    // 没接外挂料盘时留一个空心虚框占位：标签后面空着会像是渲染漏了，
    // 也顺带把同一行的两段对齐，四台机器横着扫的时候位置一致。
    const extCls = 'slot ext'
      + (hasExt ? (f.external.color ? '' : ' unknown') + (f.external.active ? ' active' : '') : ' none');
    const d = el('span', extCls);
    if (hasExt && f.external.color) d.style.setProperty('--c', f.external.color);
    d.title = hasExt ? t('card.amsExt') : t('card.extOff');
    q.ams.append(d);

    const info = [];
    const u0 = units[0];
    if (u0 && u0.humidityText) info.push(t('hum.' + u0.humidityText));
    if (u0 && u0.temp != null) info.push(`${Math.round(u0.temp)}°`);
    if (info.length) q.ams.append(el('span', 'ams-meta', info.join(' · ')));
  }
  show(q.ams, q.ams.childElementCount > 0);

  // 错误块
  q.err.replaceChildren();
  const hms = v.hms || [];
  const reasonText = (v.error && v.error.text) || null;
  if (v.statusClass === 'failed' && (hms.length || reasonText)) {
    if (hms.length) {
      const row = el('div', 'hms-row');
      row.append(el('span', 'hms', 'HMS'));
      for (const h of hms.slice(0, 3)) {
        const c = el('span', 'hms', h.code);
        const txt = v.error && v.error.hmsTexts && v.error.hmsTexts[h.code];
        if (txt) c.title = txt;
        row.append(c);
      }
      if (hms.length > 3) row.append(el('span', 'hms', t('card.hmsMore', { n: hms.length - 3 })));
      q.err.append(row);
    }
    if (reasonText) q.err.append(el('div', 'reason', reasonText));
  }
  show(q.err, q.err.childElementCount > 0);

  // 任务名
  if (v.job && v.job !== v.name) {
    q.job.replaceChildren(el('b', null, t('card.job') + ' '), document.createTextNode(v.job));
    show(q.job, true);
  } else {
    show(q.job, false);
  }

  const entry = cards.get(v.serial);
  if (entry && entry.expanded) renderDetail(entry, v);
}

// ── 空状态 ──
function renderEmpty(reason) {
  const wrap = el('div', 'empty');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('width', '44');
  svg.setAttribute('height', '44');
  svg.innerHTML = '<path d="M24 6v7" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>'
    + '<path d="M15 13h18l-9 13z" fill="currentColor"/>'
    + '<rect x="8" y="30" width="32" height="4" rx="2" fill="currentColor" opacity=".85"/>'
    + '<rect x="13" y="37" width="22" height="4" rx="2" fill="currentColor" opacity=".45"/>';
  wrap.append(svg);

  if (reason === 'no-printers') {
    wrap.append(el('h2', null, t('pop.empty.noPrinters')));
    wrap.append(el('p', null, t('set.printers.autoSync')));
  } else {
    wrap.append(el('h2', null, t('pop.empty.title')));
    wrap.append(el('p', null, t('pop.empty.desc')));
    const row = el('div', 'row');
    const b1 = el('button', 'btn primary', t('pop.empty.login'));
    b1.addEventListener('click', () => window.bambu.openSettings('account'));
    const b2 = el('button', 'btn', t('pop.empty.addLan'));
    b2.addEventListener('click', () => window.bambu.openSettings('printers'));
    row.append(b1, b2);
    wrap.append(row);
  }
  return wrap;
}

// ── 整表渲染 ──
let lastSig = '';
function render() {
  if (!snap) return;
  document.getElementById('summary').textContent = summaryText(snap.summary);
  document.getElementById('demoBadge').hidden = snap.mode !== 'demo';
  document.getElementById('demoBadge').textContent = t('pop.demo');

  const list = document.getElementById('list');
  const printers = snap.printers || [];

  const sig = printers.map((v) => v.serial).join(',') + '|' + (printers.length ? '' : snap.emptyReason || '');
  if (sig !== lastSig) {
    // 台数或顺序变了：清掉不再存在的卡片，重建列表
    lastSig = sig;
    const alive = new Set(printers.map((v) => v.serial));
    for (const key of [...cards.keys()]) if (!alive.has(key)) cards.delete(key);
    list.replaceChildren();
    if (!printers.length) list.append(renderEmpty(snap.emptyReason));
    for (const v of printers) list.append(cardFor(v).root);
  }
  for (const v of printers) updateCard(v);

  measure();
}

let measureTimer = null;
let lastSentHeight = 0;
function measure() {
  clearTimeout(measureTimer);
  measureTimer = setTimeout(() => {
    const panel = document.getElementById('panel');
    // 先解除高度上限量「自然高度」，再由主进程按工作区夹紧 ——
    // 否则量到的是被窗口夹紧后的高度，窗口就再也长不高了。
    panel.classList.add('measuring');
    const natural = Math.ceil(panel.getBoundingClientRect().height);
    panel.classList.remove('measuring');
    const cap = (snap && snap.prefs && snap.prefs.maxPanelHeight) || 720;
    const h = Math.min(natural, cap);
    // 差值小于 4px 就不发：文本里数字从「1h23m」变成「1h3m」这类微小的换行抖动
    // 会被这条阈值吃掉，避免面板每秒都在改窗口尺寸。
    if (Math.abs(h - lastSentHeight) < 4) return;
    lastSentHeight = h;
    window.bambu.setHeight(h);
  }, 30);
}

// ── 事件 ──
document.getElementById('btnRefresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.classList.add('spin');
  await window.bambu.refreshAll();
  flash(t('pop.refresh.done'));
  setTimeout(() => btn.classList.remove('spin'), 600);
});
const openSet = () => window.bambu.openSettings('general');
document.getElementById('btnSettings2').addEventListener('click', openSet);
document.getElementById('btnQuit').addEventListener('click', () => window.bambu.quit());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.bambu.hidePanel();
  if (e.key === 'r' && (e.metaKey || e.ctrlKey)) window.bambu.refreshAll();
});

// 面板上没有常驻计时器：页脚的「更新于 x 秒前」已移除（它每帧归零，会伪装成
// 「面板在定时刷新」）。相对时间只剩「完成 · X 分钟前」这类状态文案，由主进程
// 在每次推快照时按此刻重算（statusTextOf），不需要渲染层自己走秒。

// 内容尺寸变化（展开详情 / 增删卡片 / 切语言）后重算窗口高度
new ResizeObserver(() => measure()).observe(document.getElementById('panel'));

// ── 焦点 ────────────────────────────────────────────────────────────────
// 输入模态：只有用户真的按了 Tab，才认为他在用键盘，才显示焦点环（规则在 style.css）。
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') document.body.classList.add('kbd');
}, true);
document.addEventListener('pointerdown', () => document.body.classList.remove('kbd'), true);

// 面板一打开，Chromium 的初始焦点会落在第一个可聚焦元素（刷新按钮）上。
// 那不是用户的选择：既不该显示焦点环，也不该让一次误敲空格/回车就触发刷新。
// 每次窗口获得焦点都把状态复位成「指针模态」并把焦点收回面板容器
// （tabindex="-1"，不画环）；用户真按 Tab 时再切回键盘模态。
const panelEl = document.getElementById('panel');
window.addEventListener('focus', () => {
  document.body.classList.remove('kbd');
  panelEl.focus({ preventScroll: true });
});

(async function init() {
  const s = await window.bambu.getStrings();
  strings = s.table;
  locale = s.locale;
  document.documentElement.lang = locale;
  // 静态按钮的文案（建卡时已用到 t()，故必须在拿到字符串之后再建卡）
  applyStaticText();

  window.bambu.onLocale((s2) => {
    strings = s2.table;
    locale = s2.locale;
    rtf = null;
    document.documentElement.lang = locale;
    applyStaticText();
    cards.clear();
    lastSig = '';
    if (snap) render();
  });
  window.bambu.onState((next) => { snap = next; render(); });
  snap = await window.bambu.getSnapshot();
  render();
  // 首次创建面板时窗口可能已经拿到焦点（focus 事件早于监听器注册），这里补收一次。
  document.body.classList.remove('kbd');
  panelEl.focus({ preventScroll: true });
  await window.bambu.ready();
})();
