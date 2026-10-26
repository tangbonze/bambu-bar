// 设置窗渲染层。四个分页：账号（登录）/ 打印机 / 通用 / 关于。
// 登录流程全部交给主进程（bambu-auth + 浏览器登录），这里只做表单与状态呈现。

const $ = (id) => document.getElementById(id);
const api = window.bambuSettings;

let strings = {};
let locale = 'zh-CN';
let state = null;
let region = 'global';
let mode = 'code';
let smsTfaKey = null;
let pendingTfa = null; // 密码登录命中二次验证时的 {region, account, password, tfaKey}
let countdownTimer = null;

function t(key, params) {
  let s = strings[key];
  if (s == null) s = key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return s;
}

// Electron 不支持 window.prompt()，重命名用自建轻量弹窗。
function askText(title, initial, onOk) {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  const box = document.createElement('div');
  box.className = 'modal-box';
  const h = document.createElement('div');
  h.className = 'modal-title';
  h.textContent = title;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = initial || '';
  const row = document.createElement('div');
  row.className = 'modal-row';
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = t('settings.renameCancel');
  const ok = document.createElement('button');
  ok.className = 'btn primary';
  ok.textContent = t('settings.renameSave');
  row.append(cancel, ok);
  box.append(h, input, row);
  wrap.append(box);
  document.body.append(wrap);
  input.focus();
  input.select();
  const close = () => wrap.remove();
  cancel.addEventListener('click', close);
  ok.addEventListener('click', () => { const v = input.value.trim(); close(); if (v) onOk(v); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const v = input.value.trim(); close(); if (v) onOk(v); }
    if (e.key === 'Escape') close();
  });
}

const setMsg = (elm, text, kind) => {
  elm.textContent = text || '';
  elm.className = 'msg' + (kind ? ' ' + kind : '');
};

// ── 静态文案 ──
function applyStaticText() {
  document.querySelector('[data-tab="account"]').textContent = t('set.tab.account');
  document.querySelector('[data-tab="printers"]').textContent = t('set.tab.printers');
  document.querySelector('[data-tab="general"]').textContent = t('set.tab.general');
  document.querySelector('[data-tab="about"]').textContent = t('set.tab.about');

  $('h-account').textContent = t('set.tab.account');
  $('lblRegion').textContent = t('set.account.region');
  document.querySelector('[data-region="global"]').textContent = t('set.account.global');
  document.querySelector('[data-region="china"]').textContent = t('set.account.china');
  $('ttlBrowser').textContent = t('set.account.browser');
  $('hintBrowser').textContent = t('set.account.browserHint');
  $('btnBrowserLogin').textContent = t('set.account.browserBtn');
  $('btnLogout').textContent = t('set.account.logout');
  document.querySelector('[data-mode="code"]').textContent = t('set.account.sms');
  document.querySelector('[data-mode="password"]').textContent = t('set.account.password');
  $('lblPhone').textContent = t('set.account.phone');
  $('lblCode').textContent = t('set.account.code');
  $('lblAccount').textContent = t('set.account.account');
  $('lblPassword').textContent = t('set.account.passwordField');
  $('lblVerify').textContent = t('set.account.code');
  $('btnSendCode').textContent = t('set.account.sendCode');
  $('btnLogin').textContent = t('set.account.login');

  $('h-printers').textContent = t('set.tab.printers');
  $('h-cloud').textContent = t('set.printers.cloud');
  $('h-lan').textContent = t('set.printers.lan');
  $('h-addLan').textContent = t('set.printers.addTitle');
  $('hintCloud').textContent = t('set.printers.autoSync');
  $('hintLan').textContent = t('set.printers.lanHint');
  $('lblHost').textContent = t('set.printers.host');
  $('lblAccess').textContent = t('set.printers.accessCode');
  $('lblSerial').textContent = t('set.printers.serial');
  $('lblName').textContent = t('set.printers.name');
  $('btnAddLan').textContent = t('set.printers.test');

  $('h-general').textContent = t('set.tab.general');
  $('lblTheme').textContent = t('set.general.theme');
  $('hintTheme').textContent = t('set.general.themeDesc');
  $('optThemeSystem').textContent = t('set.general.themeSystem');
  $('optThemeLight').textContent = t('set.general.themeLight');
  $('optThemeDark').textContent = t('set.general.themeDark');
  $('lblLang').textContent = t('set.general.language');
  $('lblPoll').textContent = t('set.general.poll');
  $('hintPoll').textContent = t('set.general.pollDesc');
  $('optPollFast').textContent = t('set.general.pollFast');
  $('optPollNormal').textContent = t('set.general.pollNormal');
  $('optPollSlow').textContent = t('set.general.pollSlow');
  $('ttlTrayPct').textContent = t('set.general.trayPercent');
  $('descTrayPct').textContent = t('set.general.trayPercentDesc');
  $('ttlLaunch').textContent = t('set.general.launchAtLogin');
  $('ttlNotify').textContent = t('set.general.notify');
  $('descNotify').textContent = t('set.general.notifyDesc');

  $('h-about').textContent = t('set.tab.about');
  $('aboutDisclaimer').textContent = t('set.about.disclaimer');
  $('ttlDiag').textContent = t('set.about.diagnostics');
  $('descDiag').textContent = t('set.about.diagnosticsDesc');
  $('btnDiag').textContent = t('set.about.diagnostics');
  $('btnData').textContent = t('set.about.openLogs');
}

// ── 分页 ──
function switchTab(name) {
  const tab = ['account', 'printers', 'general', 'about'].includes(name) ? name : 'account';
  for (const b of document.querySelectorAll('.nav-btn')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== 'tab-' + tab;
  $('main').scrollTop = 0;
}

// ── 账号 ──
function renderAccount() {
  const acc = state.account || null;
  const logged = !!(acc && acc.loggedIn);
  $('acctLogged').hidden = !logged;
  $('acctLogin').hidden = logged;
  if (logged) {
    const name = acc.account || (acc.uid != null ? `uid ${acc.uid}` : t('set.account.loggedIn'));
    $('acctName').textContent = name;
    $('acctAvatar').textContent = String(name).trim().slice(0, 1).toUpperCase() || 'B';
    const sub = [t('set.account.' + (acc.region === 'china' ? 'china' : 'global')),
      t('set.account.devices', { n: state.cloudPrinters.length })];
    $('acctSub').textContent = sub.join(' · ');
  }
  // 区域分段：已登录时按账号所在区域高亮，仍未登录则跟随用户选择
  const effRegion = logged ? (acc.region || 'global') : region;
  for (const b of document.querySelectorAll('[data-region]')) b.classList.toggle('active', b.dataset.region === effRegion);
  $('paneGlobal').hidden = effRegion !== 'global';
  $('paneChina').hidden = effRegion !== 'china';
  for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('active', b.dataset.mode === mode);
  $('formCode').hidden = mode !== 'code';
  $('formPassword').hidden = mode !== 'password';
}

async function afterLogin() {
  const r = await api.completeCloudLogin();
  if (!r.ok) { setMsg($('msgAccount'), r.error || t('set.error'), 'err'); return; }
  await reload();
  setMsg($('msgAccount'), `${t('set.account.loggedIn')} · ${t('set.account.devices', { n: r.deviceCount || 0 })}`, 'ok');
  switchTab('printers');
}

document.querySelectorAll('[data-region]').forEach((b) => b.addEventListener('click', () => {
  region = b.dataset.region;
  renderAccount();
}));
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  mode = b.dataset.mode;
  renderAccount();
}));

$('btnBrowserLogin').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  setMsg($('msgAccount'), t('set.account.syncing'));
  const r = await api.browserLogin(region);
  btn.disabled = false;
  if (!r.ok) {
    if (r.canceled) { setMsg($('msgAccount'), ''); return; }
    setMsg($('msgAccount'), r.error || t('set.error'), 'err');
    return;
  }
  await afterLogin();
});

$('btnSendCode').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const phone = $('inPhone').value.trim();
  if (!phone) { setMsg($('msgAccount'), t('settings.errPhoneRequired'), 'err'); return; }
  btn.disabled = true;
  const r = await api.requestSmsCode(region, phone);
  if (!r.ok) {
    btn.disabled = false;
    setMsg($('msgAccount'), r.error || t('set.error'), 'err');
    return;
  }
  smsTfaKey = r.tfaKey || null;
  setMsg($('msgAccount'), t('set.account.codeSent'), 'ok');
  let left = 60;
  clearInterval(countdownTimer);
  btn.textContent = t('set.account.resend', { n: left });
  countdownTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(countdownTimer);
      btn.disabled = false;
      btn.textContent = t('set.account.sendCode');
      return;
    }
    btn.textContent = t('set.account.resend', { n: left });
  }, 1000);
});

$('btnLogin').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  setMsg($('msgAccount'), '');
  try {
    let r;
    if (mode === 'code') {
      const phone = $('inPhone').value.trim();
      const code = $('inCode').value.trim();
      if (!phone || !code) { setMsg($('msgAccount'), t('auth.errPhoneCodeRequired'), 'err'); return; }
      r = await api.loginWithCode(region, phone, code, smsTfaKey);
    } else if (pendingTfa) {
      r = await api.verify(pendingTfa.region, pendingTfa.account, pendingTfa.password, pendingTfa.tfaKey, $('inVerify').value.trim());
    } else {
      const account = $('inAccount').value.trim();
      const password = $('inPassword').value;
      if (!account || !password) { setMsg($('msgAccount'), t('auth.errAccountPasswordRequired'), 'err'); return; }
      r = await api.login(region, account, password);
      if (r && r.needsVerify) {
        pendingTfa = { region, account, password, tfaKey: r.tfaKey };
        $('fieldVerify').hidden = false;
        $('inVerify').focus();
        setMsg($('msgAccount'), t('settings.verifyHint'));
        return;
      }
    }
    if (!r.ok) { setMsg($('msgAccount'), r.error || t('set.error'), 'err'); return; }
    pendingTfa = null;
    $('fieldVerify').hidden = true;
    await afterLogin();
  } finally {
    btn.disabled = false;
  }
});

$('btnLogout').addEventListener('click', async () => {
  await api.logout();
  pendingTfa = null;
  await reload();
  setMsg($('msgAccount'), '');
});

// ── 打印机 ──
function badge(text, cls) {
  const b = document.createElement('span');
  b.className = 'badge' + (cls ? ' ' + cls : '');
  b.textContent = text;
  return b;
}

function printerItem({ name, sub, badges, actions }) {
  const item = document.createElement('div');
  item.className = 'item';
  const main = document.createElement('div');
  main.className = 'item-main';
  const n = document.createElement('div');
  n.className = 'item-name';
  n.append(document.createTextNode(name));
  for (const b of badges || []) n.append(b);
  const s = document.createElement('div');
  s.className = 'item-sub';
  s.textContent = sub || '';
  main.append(n, s);
  const acts = document.createElement('div');
  acts.className = 'item-actions';
  for (const a of actions || []) acts.append(a);
  item.append(main, acts);
  return item;
}

function mkBtn(label, cls, fn) {
  const b = document.createElement('button');
  b.className = 'btn sm' + (cls ? ' ' + cls : '');
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

function renderPrinters() {
  const cloud = $('listCloud');
  cloud.replaceChildren();
  if (!state.cloudPrinters.length) {
    const d = document.createElement('div');
    d.className = 'empty-line';
    d.textContent = state.account && state.account.token ? t('pop.empty.noPrinters') : t('set.account.notLoggedIn');
    cloud.append(d);
  }
  for (const p of state.cloudPrinters) {
    const badges = [];
    badges.push(badge(p.online === true ? t('settings.deviceOnline') : p.online === false ? t('settings.deviceOffline') : t('settings.deviceUnknown'),
      p.online === true ? 'on' : 'off'));
    if (p.hidden) badges.push(badge(t('card.hide'), 'hidden'));
    const actions = [
      mkBtn(t('set.printers.rename'), '', () => {
        askText(t('set.printers.renamePrompt'), p.name || '', async (name) => {
          await api.rename(p.serial, name);
          await reload();
        });
      }),
      mkBtn(t('card.hide'), '', async () => { await api.setHidden(p.serial, !p.hidden); await reload(); }),
    ];
    cloud.append(printerItem({
      name: p.name || p.serial,
      sub: [p.model, p.serial].filter(Boolean).join(' · '),
      badges,
      actions,
    }));
  }

  const lan = $('listLan');
  lan.replaceChildren();
  if (!state.lanPrinters.length) {
    const d = document.createElement('div');
    d.className = 'empty-line';
    d.textContent = t('set.printers.empty');
    lan.append(d);
  }
  for (const p of state.lanPrinters) {
    const badges = [badge(t('card.source.lan'), 'on')];
    if (p.hidden) badges.push(badge(t('card.hide'), 'hidden'));
    lan.append(printerItem({
      name: p.name || p.serial,
      sub: [p.host, p.serial].filter(Boolean).join(' · '),
      badges,
      actions: [
        mkBtn(t('set.printers.rename'), '', () => {
          askText(t('set.printers.renamePrompt'), p.name || '', async (name) => {
            await api.rename(p.serial, name);
            await reload();
          });
        }),
        mkBtn(t('set.printers.remove'), 'danger', async () => {
          await api.removeLan(p.serial);
          await reload();
          setMsg($('msgLan'), t('set.removed'), 'ok');
        }),
      ],
    }));
  }
}

$('btnAddLan').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const payload = {
    host: $('inHost').value.trim(),
    accessCode: $('inAccess').value.trim(),
    serial: $('inSerial').value.trim(),
    name: $('inName').value.trim(),
  };
  if (!payload.host || !payload.accessCode || !payload.serial) {
    btn.disabled = false;
    setMsg($('msgLan'), t('settings.errLanFields'), 'err');
    return;
  }
  setMsg($('msgLan'), t('set.printers.testing'));
  const r = await api.addLan(payload);
  btn.disabled = false;
  if (!r.ok) { setMsg($('msgLan'), r.error || t('set.error'), 'err'); return; }
  setMsg($('msgLan'), t('settings.connSuccess'), 'ok');
  $('inHost').value = ''; $('inAccess').value = ''; $('inSerial').value = ''; $('inName').value = '';
  await reload();
});

// ── 通用 ──
function renderGeneral() {
  $('selTheme').value = state.prefs.theme || 'system';
  $('selLang').value = state.locale;
  $('selPoll').value = String(state.prefs.pollMs || 45000);
  $('swTrayPct').checked = !!state.prefs.showTrayPercent;
  $('swLaunch').checked = !!state.prefs.launchAtLogin;
  $('swNotify').checked = !!state.prefs.notify;
}

// 明暗：改的是 nativeTheme.themeSource，主进程会把它同步给所有窗口；
// 两个窗口的样式都走 @media (prefers-color-scheme)，所以是立即生效、无需重启。
$('selTheme').addEventListener('change', async (e) => {
  await api.setPref('theme', e.target.value);
  await reload();
});

$('selLang').addEventListener('change', async (e) => {
  const v = e.target.value;
  await api.setPref('locale', v);
  await loadStrings();
  await reload();
});

$('selPoll').addEventListener('change', async (e) => {
  await api.setPref('pollMs', Number(e.target.value));
  await reload();
});
$('swTrayPct').addEventListener('change', async (e) => {
  await api.setPref('showTrayPercent', e.target.checked);
});
$('swLaunch').addEventListener('change', async (e) => {
  await api.setPref('launchAtLogin', e.target.checked);
});
$('swNotify').addEventListener('change', async (e) => {
  await api.setPref('notify', e.target.checked);
});

// ── 关于 ──
function renderAbout() {
  $('aboutVer').textContent = `${t('set.about.version')} ${state.version || ''}`;
}

$('btnDiag').addEventListener('click', async () => {
  const text = await api.diagnostics();
  await api.copy(text);
  setMsg($('msgAbout'), t('set.about.copied'), 'ok');
});
$('btnData').addEventListener('click', () => api.revealData());

// ── 生命周期 ──
async function loadStrings() {
  const s = await api.getStrings();
  strings = s.table;
  locale = s.locale;
  document.documentElement.lang = locale;
  applyStaticText();
}

async function reload() {
  state = await api.getSettings();
  renderAccount();
  renderPrinters();
  renderGeneral();
  renderAbout();
}

document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
api.onNavigate((section) => switchTab(section));
api.onPrintersChanged(() => { reload().catch(() => {}); });

(async function init() {
  await loadStrings();
  await reload();
  switchTab((location.hash || '#account').slice(1));
  window.addEventListener('hashchange', () => switchTab(location.hash.slice(1)));
})();
