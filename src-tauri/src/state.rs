// 全局运行时状态：配置 + 每台机的报文 + 连接控制。

use crate::config::Config;
use crate::printer::PrinterState;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

pub struct AppState {
    pub cfg: Mutex<Config>,
    pub config_dir: PathBuf,
    printers: Mutex<HashMap<String, PrinterState>>,
    /// 已被移除/停止的机器：连接任务据此自行退出。
    stop: Mutex<HashSet<String>>,
    /// 每台机的 pushall 触发通道（面板点刷新时用）。
    push: Mutex<HashMap<String, broadcast::Sender<()>>>,
    pub conn_errors: Mutex<HashMap<String, String>>,
    /// 已经起过连接任务的机器（避免重复 spawn 出多条 MQTT 连接）。
    started: Mutex<HashSet<String>>,
    /// 演示数据循环是否已经在跑（防止重复切换演示开关时起出多条定时器）。
    pub demo_started: AtomicBool,
}

impl AppState {
    pub fn new(cfg: Config, config_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            cfg: Mutex::new(cfg),
            config_dir,
            printers: Mutex::new(HashMap::new()),
            stop: Mutex::new(HashSet::new()),
            push: Mutex::new(HashMap::new()),
            conn_errors: Mutex::new(HashMap::new()),
            started: Mutex::new(HashSet::new()),
            demo_started: AtomicBool::new(false),
        })
    }

    /// 抢占式登记：返回 true 表示「这条连接该由本次调用启动」。
    pub fn claim(&self, serial: &str) -> bool {
        self.started.lock().unwrap().insert(serial.to_string())
    }

    pub fn release(&self, serial: &str) {
        self.started.lock().unwrap().remove(serial);
    }

    pub fn save_config(&self) {
        let cfg = self.cfg.lock().unwrap().clone();
        if let Err(e) = cfg.save(&self.config_dir) {
            eprintln!("[config] 保存失败: {e}");
        }
    }

    /// 在锁内修改单台机状态。闭包拿不到 HashMap 迭代器，只能改这一台——
    /// 避免「拿着 map 的锁去做别的事」这类死锁。
    pub fn with_printer<R>(&self, serial: &str, f: impl FnOnce(&mut PrinterState) -> R) -> R {
        let mut map = self.printers.lock().unwrap();
        let ps = map.entry(serial.to_string()).or_default();
        f(ps)
    }

    pub fn set_online(&self, serial: &str, online: bool) {
        self.with_printer(serial, |ps| ps.online = online);
    }

    /// 通道断了才判离线，而且要「确实很久没有报文」才判。
    /// 同一台机可能同时挂着云端 + 局域网两条连接，其中一条抖动不该让菜单栏
    /// 立刻变成离线——另一个通道可能一秒前刚送过数据。
    pub fn set_offline_if_stale(&self, serial: &str, after: std::time::Duration) {
        let stale = self.with_printer(serial, |ps| {
            ps.last_seen.map(|t| t.elapsed() > after).unwrap_or(true)
        });
        if stale {
            self.set_online(serial, false);
        }
    }

    pub fn set_conn_error(&self, serial: &str, err: &str) {
        self.conn_errors.lock().unwrap().insert(serial.to_string(), err.to_string());
    }

    pub fn should_stop(&self, serial: &str) -> bool {
        self.stop.lock().unwrap().contains(serial)
    }

    /// 停止并标记某台机（从账号里删除设备时调用）。
    pub fn stop_printer(&self, serial: &str) {
        self.stop.lock().unwrap().insert(serial.to_string());
        self.printers.lock().unwrap().remove(serial);
    }

    /// 让某台机重新开始连接（重新登录/改配置后）。
    pub fn restart_printer(&self, serial: &str) {
        self.stop.lock().unwrap().remove(serial);
    }

    pub fn push_channel(&self, serial: &str) -> broadcast::Sender<()> {
        let mut map = self.push.lock().unwrap();
        map.entry(serial.to_string())
            .or_insert_with(|| broadcast::channel(8).0)
            .clone()
    }

    /// 面板/菜单触发的即时刷新。
    pub fn request_pushall(&self, serial: &str) {
        if let Some(tx) = self.push.lock().unwrap().get(serial).cloned() {
            let _ = tx.send(());
        }
    }

    /// 托盘快照：只取菜单栏需要的最小字段（机型 / 进度 / 状态类）。
    pub fn tray_items(&self) -> Vec<TrayItem> {
        let cfg = self.cfg.lock().unwrap();
        let printers = self.printers.lock().unwrap();
        let mut out = Vec::new();
        // 演示模式用虚拟清单：真实账号下的 printers 不被改动，这里也不看它。
        if cfg.demo_mode {
            for (serial, name, model) in crate::demo::entries() {
                out.push(TrayItem::new(&serial, &name, &model, printers.get(&serial)));
            }
            return out;
        }
        for p in &cfg.printers {
            if cfg.hidden_printers.contains(&p.serial) {
                continue;
            }
            let ps = printers.get(&p.serial);
            out.push(TrayItem::new(&p.serial, &p.name, &p.model, ps));
        }
        for p in &cfg.lan_printers {
            if cfg.hidden_printers.contains(&p.serial) {
                continue;
            }
            let ps = printers.get(&p.serial);
            out.push(TrayItem::new(&p.serial, &p.name, &p.model, ps));
        }
        out
    }
}

/// 菜单栏用的极简视图（与前端 buildPrinterView 的 statusClass/stateKey 口径一致）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct TrayItem {
    pub serial: String,
    pub name: String,
    pub model: String,
    pub state_key: String,
    pub status_class: String,
    pub percent: Option<f64>,
    pub remain_mins: Option<f64>,
    pub eta: Option<String>,
    pub job: Option<String>,
    pub online: bool,
}

impl TrayItem {
    fn new(serial: &str, name: &str, model: &str, ps: Option<&PrinterState>) -> Self {
        let Some(ps) = ps else {
            return Self {
                serial: serial.into(), name: name.into(), model: model.into(),
                state_key: "offline".into(), status_class: "offline".into(),
                percent: None, remain_mins: None, eta: None, job: None, online: false,
            };
        };
        if !ps.online || ps.report.is_none() {
            return Self {
                serial: serial.into(), name: name.into(), model: model.into(),
                state_key: "offline".into(), status_class: "offline".into(),
                percent: None, remain_mins: None, eta: None, job: None, online: false,
            };
        }
        let gcode = ps.str_of("gcode_state").unwrap_or("IDLE");
        let (state_key, status_class) = classify(gcode, ps);
        let percent = ps.num_of("mc_percent");
        let remain_mins = ps
            .get("mc_remaining_time")
            .and_then(|v| v.as_f64())
            .or_else(|| ps.get("remain_time").and_then(|v| v.as_f64()).map(|s| s / 60.0));
        let eta = remain_mins.and_then(crate::tray::eta_text);
        Self {
            serial: serial.into(),
            name: name.into(),
            model: model.into(),
            state_key,
            status_class,
            percent,
            remain_mins,
            eta,
            job: ps.str_of("subtask_name").or_else(|| ps.str_of("gcode_file")).map(|s| s.to_string()),
            online: true,
        }
    }

    /// 是否参与菜单栏轮播（打印中 / 暂停 / 准备中）。
    pub fn rotating(&self) -> bool {
        matches!(self.status_class.as_str(), "printing" | "paused")
            || matches!(self.state_key.as_str(), "prepare" | "changing_filament")
    }
}

/// gcode_state → 状态类。完整版在 JS 侧（含 stage/HMS/失败原因归类），
/// 这里只做菜单栏需要的粗分类，口径与前端 live-telemetry.statusClassFromStateKey 对齐。
fn classify(gcode: &str, ps: &PrinterState) -> (String, String) {
    let canceled = ps.canceled;
    let failed_flag = ps.get("print_error").and_then(|v| v.as_bool()).unwrap_or(false);
    match gcode {
        "RUNNING" => ("printing".into(), "printing".into()),
        "PAUSE" => ("paused".into(), "paused".into()),
        "PREPARE" | "SLICING" => ("prepare".into(), "online".into()),
        "FINISH" => ("finished".into(), "finished".into()),
        "FAILED" => {
            if canceled {
                ("canceled".into(), "online".into())
            } else if failed_flag {
                ("failed".into(), "failed".into())
            } else {
                ("failed".into(), "failed".into())
            }
        }
        _ => ("idle".into(), "online".into()),
    }
}
