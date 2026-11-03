// 设置窗：登录 / 设备清单 / 显示偏好。
//
// 登录这块刻意做成「先选方式，再填一张表」：
//   账号密码 → 账号 + 密码 + 一个整宽的登录按钮
//   短信验证码 → 手机号 + 验证码（右侧「获取验证码」，带 60 秒倒计时）
// 老版本把「登录」「发送短信验证码」「刷新设备」并排放在一行，验证码行还要点出来，
// 用户不知道先点哪个——这是被明确反馈过的问题，不要再合并回去。

const { invoke } = window.__TAURI__.core;

const $ = (id) => document.getElementById(id);
const msg = $('msg');
const lanMsg = $('lanMsg');

let boot = { account: {}, printers: [], prefs: {}, locale: 'zh-CN' };
let method = 'password';
let region = 'china';
let smsTimer = 0;

function say(text, kind) {
  msg.textContent = text || '';
  msg.className = 'msg' + (kind ? ' ' + kind : '');
}

// Rust 回的是 `auth.errBadCredentials` 这类 key；没有对应条目时原样显示，
// 至少让用户看到可搜索的原因（而不是一句「出错了」）。
function humanize(err) {
  const s = String(err && err.message ? err.message : err);
  const table = {
    'auth.errBadCredentials': '账号或密码不正确',
    'auth.errAccountPasswordRequired': '请填写账号和密码',
    'auth.errPhoneCodeRequired': '请填写手机号和验证码',
    'auth.errCodeExpired': '验证码已过期，请重新获取',
    'auth.errCodeWrong': '验证码不正确，请再试一次',
    'auth.errNotLoggedIn': '还没有登录，请先登录',
    'auth.errSmsTooMany': '发送太频繁，请稍后再试',
    'auth.errSmsBlocked': '该号码暂时无法接收验证码',
    'auth.errSmsBadPhone': '手机号格式不对',
    'settings.errPhoneRequired': '请先填写手机号',
  };
  if (table[s]) return table[s];
  return s.replace(/^auth\.err/, '登录失败：').replace(/^settings\.err/, '');
}

function setBusy(busy) {
  for (const id of ['btnLogin', 'btnSms', 'btnSmsLogin', 'btnVerify', 'btnReload', 'btnLogout', 'btnLanScan', 'btnLanAdd']) {
    const el = $(id);
    if (el && !el.dataset.hold) el.disabled = busy;
  }
  // 倒计时中的按钮不参与 busy 复位
  if (!busy && smsTimer > 0) $('btnSms').disabled = true;
}

function pickMethod(next) {
  method = next;
  for (const b of $('methodSeg').children) b.classList.toggle('on', b.dataset.method === next);
  $('panePassword').hidden = next !== 'password';
  $('paneSms').hidden = next !== 'sms';
  if (next === 'sms' && !$('phone').value.trim()) {
    // 账号填的是手机号时直接带过来，少一次输入
    const a = $('account').value.trim();
    if (/^\d{6,}$/.test(a)) $('phone').value = a;
  }
  say('');
  (next === 'sms' ? $('phone') : $('account')).focus();
}

function pickRegion(next) {
  region = next;
  for (const b of $('regionSeg').children) b.classList.toggle('on', b.dataset.region === next);
  $('regionTip').textContent = next === 'china'
    ? '中国区账号（api.bambulab.cn），短信验证码也只在这里可用。'
    : '国际区账号（api.bambulab.com），不支持短信验证码，请用账号密码登录。';
}

function paintDevices() {
  const box = $('devices');
  const list = boot.printers || [];
  if (!list.length) {
    box.className = 'empty';
    box.textContent = boot.account && boot.account.loggedIn
      ? '这个账号下还没有绑定打印机。'
      : '登录后自动拉取账号下绑定的打印机。';
    return;
  }
  box.className = '';
  box.innerHTML = '';
  for (const p of list) {
    const row = document.createElement('div');
    row.className = 'dev';
    const left = document.createElement('span');
    left.textContent = p.name || p.serial;
    const right = document.createElement('span');
    right.className = 'm';
    right.textContent = [p.model, p.source === 'lan' ? '局域网' : '云端'].filter(Boolean).join(' · ');
    row.append(left, right);
    box.appendChild(row);
  }
}

function paintAccount() {
  const acc = boot.account || {};
  const badge = $('acctBadge');
  if (acc.loggedIn) {
    badge.textContent = '已登录';
    badge.classList.add('on');
    $('btnLogout').disabled = false;
  } else {
    badge.textContent = '未登录';
    badge.classList.remove('on');
    $('btnLogout').disabled = true;
  }
}

async function reload() {
  boot = await invoke('get_bootstrap');
  const acc = boot.account || {};
  region = acc.region || 'china';
  pickRegion(region);
  $('account').value = acc.account || '';
  $('trayPct').checked = boot.prefs.showTrayPercent !== false;
  $('demo').checked = !!boot.demo;
  $('platform').textContent = '平台：' + (navigator.userAgentData?.platform || navigator.platform || '—');
  paintAccount();
  paintDevices();
  paintLan();
}

// ── 登录（账号密码）──
async function doLogin() {
  const account = $('account').value.trim();
  const password = $('password').value;
  if (!account) return $('account').focus(), say('请填写账号', 'err');
  if (!password) return $('password').focus(), say('请填写密码', 'err');
  setBusy(true);
  say('正在登录…', 'busy');
  try {
    const r = await invoke('login', { region, account, password });
    if (r && r.needsVerify) {
      // 密码对了，但账号开了邮箱二次验证：直接切到验证码，不要求用户再点一次登录
      // 两个「登录」同时摆在页面上只会让人犹豫：进入验证态就把密码登录按钮收起来
      $('paneVerify').hidden = false;
      $('btnLogin').hidden = true;
      // 验证码是发给「这个账号」的，此时再让用户改账号/改区只会发出一个对不上的码。
      $('password').disabled = true;
      $('account').disabled = true;
      $('regionSeg').classList.add('locked');
      $('verifyTo').textContent = account;
      // 蓝色提示条已经把「验证码发到哪、下一步做什么」说清楚了，
      // 底下再冒一行同样的字只会和「换个账号重新登录」挤在一起。
      say('');
      $('vcode').focus();
      return;
    }
    $('password').value = '';
    resetVerify();
    await reload();
    say(`登录成功，已同步 ${(boot.printers || []).length} 台打印机`, 'ok');
  } catch (e) {
    say(humanize(e), 'err');
  } finally {
    setBusy(false);
  }
}

function resetVerify() {
  $('paneVerify').hidden = true;
  $('btnLogin').hidden = false;
  $('password').disabled = false;
  $('account').disabled = false;
  $('regionSeg').classList.remove('locked');
  $('vcode').value = '';
}

async function doVerify() {
  const account = $('account').value.trim();
  const code = $('vcode').value.trim();
  if (!code) return $('vcode').focus(), say('请填写邮箱验证码', 'err');
  setBusy(true);
  say('正在验证…', 'busy');
  try {
    await invoke('login_with_code', { region, account, code });
    resetVerify();
    $('password').value = '';
    await reload();
    say(`登录成功，已同步 ${(boot.printers || []).length} 台打印机`, 'ok');
  } catch (e) {
    say(humanize(e), 'err');
  } finally {
    setBusy(false);
  }
}

// ── 登录（短信验证码）──
function startCountdown(sec) {
  smsTimer = sec;
  const btn = $('btnSms');
  btn.disabled = true;
  btn.textContent = `${smsTimer}s 后重发`;
  clearInterval(btn._t);
  btn._t = setInterval(() => {
    smsTimer -= 1;
    if (smsTimer <= 0) {
      clearInterval(btn._t);
      btn.disabled = false;
      btn.textContent = '重新获取';
      return;
    }
    btn.textContent = `${smsTimer}s 后重发`;
  }, 1000);
}

async function doSendSms() {
  const phone = ($('phone').value || $('account').value).trim();
  if (!phone) return $('phone').focus(), say('请先填写手机号', 'err');
  $('phone').value = phone;
  setBusy(true);
  say('正在发送…', 'busy');
  try {
    await invoke('request_sms', { phone });
    say('验证码已发送，请查收短信', 'ok');
    startCountdown(60);
    $('code').focus();
  } catch (e) {
    say(humanize(e), 'err');
  } finally {
    setBusy(false);
  }
}

async function doSmsLogin() {
  const account = ($('phone').value || $('account').value).trim();
  const code = $('code').value.trim();
  if (!account) return $('phone').focus(), say('请填写手机号', 'err');
  if (!code) return $('code').focus(), say('请填写短信验证码', 'err');
  setBusy(true);
  say('正在登录…', 'busy');
  try {
    await invoke('login_with_code', { region, account, code });
    $('code').value = '';
    await reload();
    say(`登录成功，已同步 ${(boot.printers || []).length} 台打印机`, 'ok');
  } catch (e) {
    say(humanize(e), 'err');
  } finally {
    setBusy(false);
  }
}

// ── 局域网直连 ──
// 流程固定成三步，避免用户不知道该先点哪：扫（可选）→ 填访问码 → 添加。
// 「添加」内部会先试连一次，所以这里不做任何本地校验之外的花活。
function lanSay(text, kind) {
  lanMsg.textContent = text || '';
  lanMsg.className = 'msg' + (kind ? ' ' + kind : '');
}

function paintLan() {
  const list = (boot.printers || []).filter((p) => p.source === 'lan');
  const box = $('lanList');
  box.innerHTML = '';
  if (!list.length) return;
  for (const p of list) {
    const row = document.createElement('div');
    row.className = 'lan-row';
    const left = document.createElement('span');
    left.textContent = p.name || p.serial;
    const mid = document.createElement('span');
    mid.className = 'm';
    mid.textContent = [p.model, p.host].filter(Boolean).join(' · ');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'linkbtn inline';
    del.textContent = '移除';
    del.addEventListener('click', async () => {
      await invoke('lan_remove', { serial: p.serial });
      lanSay(`已移除 ${p.name || p.serial}`, 'ok');
      await reload();
    });
    row.append(left, mid, del);
    box.appendChild(row);
  }
}

async function scanLan() {
  setBusy(true);
  lanSay('正在扫描局域网…', 'busy');
  try {
    const found = await invoke('lan_discover');
    const box = $('lanFound');
    box.innerHTML = '';
    if (!found.length) {
      box.hidden = true;
      lanSay('没扫到打印机。确认电脑和打印机在同一网段，且打印机已开启局域网模式；也可以直接手填 IP。', 'err');
      return;
    }
    box.hidden = false;
    const head = document.createElement('div');
    head.className = 'found-head';
    head.textContent = `扫到 ${found.length} 台，点一行填入下面的表单`;
    box.appendChild(head);
    for (const f of found) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'found-item';
      b.innerHTML = `<b>${f.name || f.model || f.serial}</b><span>${[f.model, f.host, f.serial].filter(Boolean).join(' · ')}</span>`;
      b.addEventListener('click', () => {
        $('lanHost').value = f.host || '';
        $('lanSerial').value = f.serial || '';
        $('lanName').value = f.name || '';
        $('lanModel').value = f.model || '';
        lanSay('已填入 IP 与序列号，接着填访问码即可添加', 'busy');
        $('lanCode').focus();
      });
      box.appendChild(b);
    }
    lanSay(`扫到 ${found.length} 台，选一台后填访问码`, 'ok');
  } catch (e) {
    lanSay(humanize(e), 'err');
  } finally {
    setBusy(false);
  }
}

async function addLan() {
  const host = $('lanHost').value.trim();
  const code = $('lanCode').value.trim();
  const serial = $('lanSerial').value.trim().toUpperCase();
  if (!host) return $('lanHost').focus(), lanSay('请填写打印机 IP', 'err');
  if (!serial) return $('lanSerial').focus(), lanSay('请点「扫描局域网」自动填序列号，或手动填写', 'err');
  if (!code) return $('lanCode').focus(), lanSay('请填写访问码（打印机 设置 → 网络 → 局域网模式）', 'err');

  setBusy(true);
  lanSay('正在试连打印机…', 'busy');
  try {
    await invoke('lan_add', {
      serial, host, accessCode: code,
      name: $('lanName').value.trim(), model: $('lanModel').value.trim(),
    });
    $('lanCode').value = '';
    $('lanHost').value = '';
    $('lanSerial').value = '';
    $('lanName').value = '';
    $('lanModel').value = '';
    $('lanFound').hidden = true;
    lanSay('已添加，菜单栏会在收到第一帧报文后显示状态', 'ok');
    await reload();
  } catch (e) {
    lanSay(humanize(e), 'err');
  } finally {
    setBusy(false);
  }
}

// ── 事件绑定 ──
$('regionSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-region]');
  if (b) pickRegion(b.dataset.region);
});

$('methodSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-method]');
  if (b) pickMethod(b.dataset.method);
});

$('btnEye').addEventListener('click', () => {
  const p = $('password');
  const shown = p.type === 'text';
  p.type = shown ? 'password' : 'text';
  $('btnEye').textContent = shown ? '显示' : '隐藏';
});

$('btnLogin').addEventListener('click', doLogin);
$('btnBack').addEventListener('click', () => {
  resetVerify();
  say('');
  $('account').focus();
});
$('btnVerify').addEventListener('click', doVerify);
$('btnSms').addEventListener('click', doSendSms);
$('btnSmsLogin').addEventListener('click', doSmsLogin);
$('btnLanScan').addEventListener('click', scanLan);
$('btnLanAdd').addEventListener('click', addLan);

// 局域网表单：回车就提交，和登录表一致
for (const id of ['lanHost', 'lanCode', 'lanSerial']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addLan();
    }
  });
}

// 回车就提交当前这张表：登录页不通回车是最反直觉的一件事。
for (const [id, fn] of [
  ['account', () => (method === 'sms' ? doSmsLogin() : doLogin())],
  ['password', doLogin],
  ['vcode', doVerify],
  ['phone', () => ($('code').value.trim() ? doSmsLogin() : doSendSms())],
  ['code', doSmsLogin],
]) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      fn();
    }
  });
}

// 验证码只留数字，粘贴带空格也自动清掉
for (const id of ['code', 'vcode']) {
  $(id).addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });
}

$('btnReload').addEventListener('click', async () => {
  setBusy(true);
  try {
    const r = await invoke('reload_devices');
    say(`已同步 ${r.count} 台设备`, 'ok');
    await reload();
  } catch (e) {
    say(humanize(e), 'err');
  } finally {
    setBusy(false);
  }
});

$('btnLogout').addEventListener('click', async () => {
  await invoke('logout');
  say('已退出登录', 'ok');
  await reload();
});

$('trayPct').addEventListener('change', (e) => {
  invoke('set_pref', { key: 'showTrayPercent', value: e.target.checked });
});

$('demo').addEventListener('change', (e) => {
  invoke('set_pref', { key: 'demoMode', value: e.target.checked });
});

$('btnLogout').dataset.hold = '1';
reload()
  .then(() => pickMethod('password'))
  .catch((e) => say(humanize(e), 'err'));
