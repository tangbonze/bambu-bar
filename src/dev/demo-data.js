// 演示数据（`npm run demo` / --demo）。
//
// 存在的意义：没有打印机 / 没登录账号时，也能看到面板完整长什么样，用于改版比对与截图。
// 数据刻意覆盖四种典型形态（打印中 / 暂停缺料 / 空闲 / 失败），并复用真机报文的结构，
// 因此走的是与真机完全相同的解析链路（state-machine → printer-view），不是「假 UI」。

const { extractTemps } = require('../core/state-machine');

const SERIALS = {
  x1c: '00M09A350100001',
  p1s: '01S00C350200002',
  a1m: '0300CA350300003',
  h2d: '09400A350400004',
};

const ENTRIES = [
  { serial: SERIALS.x1c, name: 'X1 Carbon', model: 'X1C', source: 'cloud', hasCloud: true, hasLan: false, host: null, online: true },
  { serial: SERIALS.p1s, name: '工作间 P1S', model: 'P1S', source: 'both', hasCloud: true, hasLan: true, host: '192.168.1.42', online: true },
  { serial: SERIALS.a1m, name: 'A1 mini', model: 'A1mini', source: 'lan', hasCloud: false, hasLan: true, host: '192.168.1.57', online: true },
  { serial: SERIALS.h2d, name: 'H2D', model: 'H2D', source: 'cloud', hasCloud: true, hasLan: false, host: null, online: true },
];

function amsUnit(id, humidity, temp, trays) {
  return {
    id: String(id),
    humidity: String(humidity),
    temp: String(temp),
    tray: trays.map((t, i) => ({
      id: String(i),
      tray_color: t.color,
      tray_type: t.type,
      tray_id_name: t.type,
      remain: t.remain,
      nozzle_temp_min: 190,
      nozzle_temp_max: 230,
    })),
  };
}

const state = {
  x1c: {
    connected: true,
    gcode_state: 'RUNNING',
    stg_cur: 0,
    mc_percent: 42,
    mc_remaining_time: 83,
    layer_num: 118,
    total_layer_num: 280,
    subtask_name: 'benchy-hollow-v3.3mf',
    gcode_file: 'benchy-hollow-v3.3mf',
    task_id: 'demo-task-1',
    nozzle_temper: 219.8,
    nozzle_target_temper: 220,
    bed_temper: 60.1,
    bed_target_temper: 60,
    // 腔温：X1C 没有腔温控制器，真机这一栏报的是固定占位值 5（不是 34°C）。
    // 用它当演示数据，顺带保证「演示模式」与真机的显示规则一致。
    chamber_temper: 5,
    spd_lvl: 3,
    spd_mag: 124,
    wifi_signal: -52,
    nozzle_diameter: 0.4,
    nozzle_type: 'hardened_steel',
    cooling_fan_speed: '80',
    big_fan1_speed: '40',
    lights_report: [{ node: 'chamber_light', mode: 'on' }],
    ams: {
      tray_now: '0',
      ams_status: 0,
      ams: [amsUnit(0, 1, 24.2, [
        { color: 'F2F2F0FF', type: 'PLA', remain: 72 },
        { color: '1B1B1FFF', type: 'PLA', remain: 48 },
        { color: 'D93A2BFF', type: 'PETG', remain: 91 },
        { color: '2F6BD8FF', type: 'PLA', remain: 12 },
      ])],
    },
    vt_tray: { id: '254', tray_color: 'FFFFFFFF', tray_type: 'PLA', remain: -1 },
  },
  p1s: {
    connected: true,
    gcode_state: 'PAUSE',
    stg_cur: 6, // FILAMENT_RUNOUT
    mc_percent: 67,
    mc_remaining_time: 47,
    layer_num: 201,
    total_layer_num: 300,
    subtask_name: 'gridfinity-bin-6x3.3mf',
    task_id: 'demo-task-2',
    nozzle_temper: 220.0,
    nozzle_target_temper: 220,
    bed_temper: 59.4,
    bed_target_temper: 60,
    spd_lvl: 2,
    spd_mag: 100,
    wifi_signal: -61,
    nozzle_diameter: 0.4,
    cooling_fan_speed: '0',
    ams: {
      tray_now: '1',
      ams: [amsUnit(0, 3, 26.8, [
        { color: 'E8E4DAFF', type: 'PLA', remain: 0 },
        { color: '8A8A8AFF', type: 'PLA', remain: 63 },
        { color: 'B4B4B400', type: '', remain: -1 },
        { color: '00000000', type: '', remain: -1 },
      ])],
    },
    hms: [{ attr: 0x0C000100, code: 0x00010002 }],
  },
  a1m: {
    connected: true,
    gcode_state: 'IDLE',
    stg_cur: 0,
    mc_percent: 0,
    layer_num: 0,
    total_layer_num: 0,
    nozzle_temper: 28.4,
    nozzle_target_temper: 0,
    bed_temper: 27.1,
    bed_target_temper: 0,
    wifi_signal: -44,
    nozzle_diameter: 0.4,
    // A1 mini 故意不接 AMS（只挂外挂料盘）—— 四台全带 AMS 的话，面板上「AMS 置灰 /
    // 外置亮起」这条路就永远走不到，改版时看不出差别。tray_now=254 = 当前吃外挂料。
    ams: { tray_now: '254', ams: [] },
    vt_tray: { id: '254', tray_color: 'F7D64AFF', tray_type: 'PLA', remain: 84 },
  },
  h2d: {
    connected: true,
    gcode_state: 'FAILED',
    stg_cur: 0,
    mc_percent: 23,
    mc_remaining_time: 0,
    layer_num: 64,
    total_layer_num: 280,
    subtask_name: 'enclosure-bracket.3mf',
    task_id: 'demo-task-3',
    fail_reason: 0x07008009,
    nozzle_temper: 219.0,
    nozzle_target_temper: 220,
    bed_temper: 60.0,
    bed_target_temper: 60,
    // H2D 带腔温控制器：device.ctc.info.temp 是一个 int 打包（低 16 位当前 / 高 16 位目标），
    // 42/40 打包 = (40<<16)|42 = 2621482。腔温只认这个字段，扁平 chamber_temper 不作数
    // （见 printer-view.js 的 resolveChamberTemp）。
    device: { ctc: { info: { temp: (40 << 16) | 42 } } },
    chamber_temper: 42,
    wifi_signal: -66,
    nozzle_diameter: 0.4,
    ams: {
      tray_now: '4',
      ams: [amsUnit(1, 4, 28.5, [
        { color: '2B2B2FFF', type: 'ABS', remain: 31 },
        { color: 'D0D0D0FF', type: 'ABS', remain: 66 },
      ])],
    },
    hms: [{ attr: 0x0C000200, code: 0x00020005 }, { attr: 0x05000500, code: 0x00010007 }],
  },
};

let timer = null;
let cb = null;
const stateMap = new Map(Object.entries(state));

function demoEntries() {
  return ENTRIES.map((e) => ({ ...e, online: !!stateMap.get(keyOf(e.serial)) }));
}

function keyOf(serial) {
  return Object.keys(SERIALS).find((k) => SERIALS[k] === serial);
}

// 让「打印中」的那台动起来（进度 / 层数 / 剩余时间），其余保持静止。
function tick() {
  const s = stateMap.get('x1c');
  if (!s) return;
  s.mc_percent = Math.min(99, s.mc_percent + 1);
  s.layer_num = Math.min(s.total_layer_num, s.layer_num + 3);
  s.mc_remaining_time = Math.max(1, s.mc_remaining_time - 2);
  s.nozzle_temper = Math.min(221, s.nozzle_temper + 0.2);
}

/**
 * 启动演示循环。cb 每次 tick 后被调用，用于重推面板。
 * 与真机路径的差别仅在于「报文从哪来」，解析链路完全一致。
 */
function start(onTick) {
  cb = onTick;
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    tick();
    if (cb) cb();
  }, 3000);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

// 某台的最新演示报文（main 的 applyReport 入口消费）。
function reportFor(serial) {
  const key = keyOf(serial);
  const s = key && stateMap.get(key);
  return s ? JSON.parse(JSON.stringify(s)) : null;
}

function serials() {
  return Object.values(SERIALS);
}

module.exports = { demoEntries, start, stop, tick, reportFor, serials, SERIALS, extractTemps };
