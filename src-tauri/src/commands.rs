// 前端 ↔ Rust 的 IPC。
//
// 设计原则：Rust 只做「IO 与窗口」，视图模型仍由前端 JS 核心（从 Electron 版原样打包）
// 计算 —— 字段兼容逻辑（新旧固件温度打包、AMS 深合并后的空槽语义等）只存在一份，
// 不因为换框架而重写一遍、也不会在两边产生行为漂移。

use crate::config::Config;
use crate::state::AppState;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
pub struct Bootstrap {
    pub locale: String,
    pub demo: bool,
    pub account: Value,
    pub printers: Vec<Value>,
    pub prefs: Value,
}

fn entries(cfg: &Config) -> Vec<Value> {
    let mut out = Vec::new();
    if cfg.demo_mode {
        for (serial, name, model) in crate::demo::entries() {
            out.push(json!({
                "serial": serial, "name": name, "model": model,
                "source": "cloud", "hidden": false,
            }));
        }
        return out;
    }
    for p in &cfg.printers {
        out.push(json!({
            "serial": p.serial, "name": p.name, "model": p.model,
            "source": "cloud", "hidden": cfg.hidden_printers.contains(&p.serial),
        }));
    }
    for p in &cfg.lan_printers {
        out.push(json!({
            "serial": p.serial, "name": p.name, "model": p.model,
            "source": "lan", "host": p.host, "hidden": cfg.hidden_printers.contains(&p.serial),
        }));
    }
    out
}

fn bootstrap_value(state: &Arc<AppState>) -> Bootstrap {
    let cfg = state.cfg.lock().unwrap().clone();
    let acc = cfg.account.clone().unwrap_or_default();
    Bootstrap {
        locale: cfg.locale.clone(),
        demo: cfg.demo_mode,
        account: json!({
            "loggedIn": !acc.token.is_empty(),
            "region": if acc.region.is_empty() { cfg.region.clone() } else { acc.region.clone() },
            "account": acc.account,
            "uid": acc.uid,
        }),
        printers: entries(&cfg),
        prefs: json!({
            "showTrayPercent": cfg.show_tray_percent,
            "panelWidth": cfg.panel_width,
            "theme": cfg.theme,
        }),
    }
}

#[tauri::command]
pub fn get_bootstrap(state: State<'_, Arc<AppState>>) -> Bootstrap {
    bootstrap_value(&state)
}

/// 面板自己量出自然高度后回调这里。
/// 前端传的是 CSS px（getBoundingClientRect），Tauri 的 LogicalSize 也吃 CSS px，
/// 所以**不能**再乘/除 scale_factor —— 除一次在高分屏上窗口就只有一半高。
#[tauri::command]
pub fn set_panel_height(app: AppHandle, height: f64) {
    if let Some(w) = app.get_webview_window("popover") {
        let h = height.clamp(120.0, 900.0);
        let _ = w.set_size(tauri::LogicalSize::new(crate::windows::POPOVER_W, h));
        if std::env::var_os("BAMBU_BAR_DEBUG_TRAY").is_some() {
            eprintln!("[panel] resize -> {}x{}", crate::windows::POPOVER_W, h);
        }
    }
}

#[tauri::command]
pub fn hide_panel(app: AppHandle) {
    if let Some(w) = app.get_webview_window("popover") {
        let _ = w.hide();
    }
}

#[tauri::command]
pub fn refresh_all(state: State<'_, Arc<AppState>>) {
    for item in state.tray_items() {
        state.request_pushall(&item.serial);
    }
}

#[tauri::command]
pub fn refresh_one(state: State<'_, Arc<AppState>>, serial: String) {
    state.request_pushall(&serial);
}

#[tauri::command]
pub fn set_hidden(app: AppHandle, state: State<'_, Arc<AppState>>, serial: String, hidden: bool) {
    {
        let mut cfg = state.cfg.lock().unwrap();
        cfg.hidden_printers.retain(|s| s != &serial);
        if hidden {
            cfg.hidden_printers.push(serial.clone());
        }
    }
    state.save_config();
    crate::emit_bootstrap(&app, &state.inner().clone());
}

#[tauri::command]
pub fn rename_printer(app: AppHandle, state: State<'_, Arc<AppState>>, serial: String, name: String) {
    {
        let mut cfg = state.cfg.lock().unwrap();
        for p in cfg.printers.iter_mut() {
            if p.serial == serial { p.name = name.clone(); }
        }
        for p in cfg.lan_printers.iter_mut() {
            if p.serial == serial { p.name = name.clone(); }
        }
    }
    state.save_config();
    crate::emit_bootstrap(&app, &state.inner().clone());
}

#[tauri::command]
pub fn open_settings(app: AppHandle) {
    crate::windows::show_settings(&app);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn diagnostics(state: State<'_, Arc<AppState>>) -> Value {
    let items = state.tray_items();
    json!({
        "printers": items,
        "errors": state.conn_errors.lock().unwrap().clone(),
        "platform": std::env::consts::OS,
    })
}

// ─────────────────────────── 设置窗用的账号命令 ───────────────────────────

#[tauri::command]
pub async fn login(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    region: String,
    account: String,
    password: String,
) -> Result<Value, String> {
    let r = crate::auth::login(&region, &account, &password).await?;
    if r.needs_verify {
        return Ok(json!({ "ok": false, "needsVerify": true, "tfaKey": r.tfa_key }));
    }
    let uid = if r.uid.is_empty() { crate::auth::get_uid(&region, &r.token).await.unwrap_or_default() } else { r.uid };
    // 先 await 拿设备列表，再进锁——MutexGuard 不能跨 await 存活（Future 要求 Send）。
    let devices = crate::auth::list_devices(&region, &r.token).await.ok();
    {
        let mut cfg = state.cfg.lock().unwrap();
        cfg.region = region.clone();
        cfg.account = Some(crate::config::Account {
            token: r.token.clone(), uid: uid.clone(), account: account.clone(), region: region.clone(),
        });
        // 登录后立刻拉设备列表，用户不必再点一次「刷新设备」
        if let Some(devices) = devices {
            cfg.printers = devices.iter().filter_map(|d| {
                Some(crate::config::PrinterEntry {
                    serial: d.get("serial")?.as_str()?.to_string(),
                    name: d.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    model: d.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    online: d.get("online").and_then(|v| v.as_bool()).unwrap_or(false),
                })
            }).collect();
        }
    }
    state.save_config();
    let arc = state.inner().clone();
    crate::start_connections(&app, &arc);
    crate::emit_bootstrap(&app, &arc);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn login_with_code(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    region: String,
    account: String,
    code: String,
) -> Result<Value, String> {
    let r = crate::auth::login_with_code(&region, &account, &code).await?;
    let uid = if r.uid.is_empty() { crate::auth::get_uid(&region, &r.token).await.unwrap_or_default() } else { r.uid };
    // 这条路径同时承担「邮箱二次验证」和「短信验证码登录」，两条都是正式登录成功。
    // 之前这里漏了拉设备清单，于是设置页提示「已开始读取打印机状态」而设备列表空着，
    // 用户必须先手动点一次「刷新设备」——和账号密码登录的体验不一致。
    let devices = crate::auth::list_devices(&region, &r.token).await.ok();
    {
        let mut cfg = state.cfg.lock().unwrap();
        cfg.region = region.clone();
        cfg.account = Some(crate::config::Account {
            token: r.token.clone(), uid, account: account.clone(), region,
        });
        if let Some(devices) = devices {
            cfg.printers = devices.iter().filter_map(|d| {
                Some(crate::config::PrinterEntry {
                    serial: d.get("serial")?.as_str()?.to_string(),
                    name: d.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    model: d.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    online: d.get("online").and_then(|v| v.as_bool()).unwrap_or(false),
                })
            }).collect();
        }
    }
    state.save_config();
    let arc = state.inner().clone();
    crate::start_connections(&app, &arc);
    crate::emit_bootstrap(&app, &arc);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn request_sms(phone: String) -> Result<Value, String> {
    crate::auth::request_sms_code(&phone).await?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn reload_devices(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let (region, token) = {
        let cfg = state.cfg.lock().unwrap();
        let acc = cfg.account.clone().unwrap_or_default();
        (cfg.region.clone(), acc.token.clone())
    };
    if token.is_empty() {
        return Err("auth.errNotLoggedIn".into());
    }
    let devices = crate::auth::list_devices(&region, &token).await?;
    {
        let mut cfg = state.cfg.lock().unwrap();
        cfg.printers = devices.iter().filter_map(|d| {
            Some(crate::config::PrinterEntry {
                serial: d.get("serial")?.as_str()?.to_string(),
                name: d.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                model: d.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                online: d.get("online").and_then(|v| v.as_bool()).unwrap_or(false),
            })
        }).collect();
    }
    state.save_config();
    let arc = state.inner().clone();
    crate::start_connections(&app, &arc);
    crate::emit_bootstrap(&app, &arc);
    Ok(json!({ "ok": true, "count": devices.len() }))
}

#[tauri::command]
pub fn set_pref(app: AppHandle, state: State<'_, Arc<AppState>>, key: String, value: Value) {
    {
        let mut cfg = state.cfg.lock().unwrap();
        match key.as_str() {
            "showTrayPercent" => cfg.show_tray_percent = value.as_bool().unwrap_or(true),
            "theme" => cfg.theme = value.as_str().unwrap_or("system").to_string(),
            "locale" => cfg.locale = value.as_str().unwrap_or("zh-CN").to_string(),
            "demoMode" => cfg.demo_mode = value.as_bool().unwrap_or(false),
            _ => {}
        }
    }
    state.save_config();
    let arc = state.inner().clone();
    // 打开演示开关就把假数据循环拉起来（幂等，重复勾选不会叠加）。
    if arc.cfg.lock().unwrap().demo_mode {
        crate::demo::start(&app, &arc);
    }
    crate::emit_bootstrap(&app, &arc);
    crate::tray::update(&app, &arc);
}

#[tauri::command]
pub fn logout(app: AppHandle, state: State<'_, Arc<AppState>>) {
    {
        let mut cfg = state.cfg.lock().unwrap();
        cfg.account = None;
        cfg.printers.clear();
    }
    state.save_config();
    let arc = state.inner().clone();
    crate::emit_bootstrap(&app, &arc);
}

// ─────────────────────────── 局域网直连 ───────────────────────────

/// 只留主机部分：用户从浏览器复制的 `http://192.168.1.20/` 也要能用。
fn normalize_host(raw: &str) -> String {
    let t = raw.trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    let t = t.split('/').next().unwrap_or(t);
    // 带端口也剥掉：局域网 MQTT 固定 8883，填 80/443 只会让人以为配错了
    match t.rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => h.to_string(),
        _ => t.to_string(),
    }
}

#[tauri::command]
pub async fn lan_discover() -> Vec<crate::lan::Found> {
    // 2.5 秒预算：打印机回包通常在 200ms 内，剩下的时间用来等慢的机器。
    crate::lan::discover(std::time::Duration::from_millis(2500)).await
}

#[tauri::command]
pub async fn lan_probe(host: String, serial: String, access_code: String) -> Result<Value, String> {
    let host = normalize_host(&host);
    if host.is_empty() {
        return Err("请先填写打印机的 IP（打印机屏幕 → 设置 → 网络，可以看到本机 IP）".into());
    }
    let code = access_code.trim().to_string();
    if code.len() < 6 {
        return Err("访问码看起来不完整（8 位，在打印机 设置 → 网络 → 局域网模式 里）".into());
    }
    crate::lan::probe(&host, &serial, &code).await?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn lan_add(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    serial: String,
    host: String,
    access_code: String,
    name: String,
    model: String,
) -> Result<Value, String> {
    let serial = serial.trim().to_uppercase();
    let host = normalize_host(&host);
    let code = access_code.trim().to_string();
    if serial.is_empty() {
        return Err("缺少序列号：先点「扫描局域网」自动填，或去打印机屏幕抄 15 位序列号".into());
    }
    if host.is_empty() {
        return Err("请先填写打印机的 IP".into());
    }
    if code.len() < 6 {
        return Err("访问码看起来不完整（8 位，在打印机 设置 → 网络 → 局域网模式 里）".into());
    }

    // 先试连再写配置：否则菜单栏里会多出一台永远连不上的机器，
    // 用户还得回头猜是「没开机」还是「访问码错了」。
    crate::lan::probe(&host, &serial, &code).await?;

    let display = if name.trim().is_empty() { serial.clone() } else { name.trim().to_string() };
    {
        let mut cfg = state.cfg.lock().unwrap();
        cfg.lan_printers.retain(|p| p.serial != serial);
        cfg.lan_printers.push(crate::config::LanPrinter {
            serial: serial.clone(),
            name: display,
            model: model.trim().to_string(),
            host,
            access_code: code,
        });
        cfg.hidden_printers.retain(|s| s != &serial);
    }
    state.save_config();

    let arc = state.inner().clone();
    arc.restart_printer(&serial);
    crate::start_connections(&app, &arc);
    crate::emit_bootstrap(&app, &arc);
    crate::tray::update(&app, &arc);
    Ok(json!({ "ok": true, "serial": serial }))
}

#[tauri::command]
pub fn lan_remove(app: AppHandle, state: State<'_, Arc<AppState>>, serial: String) {
    {
        let mut cfg = state.cfg.lock().unwrap();
        cfg.lan_printers.retain(|p| p.serial != serial);
        // 同一台机可能同时还在云端清单里，那就只删局域网这一条通道。
        cfg.hidden_printers.retain(|s| s != &serial);
    }
    state.save_config();
    let arc = state.inner().clone();
    if !arc.cfg.lock().unwrap().printers.iter().any(|p| p.serial == serial) {
        arc.stop_printer(&serial);
    }
    crate::emit_bootstrap(&app, &arc);
    crate::tray::update(&app, &arc);
}

// ─────────────────────────── 官方 HMS 码表 ───────────────────────────

/// 取某台机器的官方错误码表（原始 JSON）。
///
/// 拿不到就返回 `Ok(None)`——前端会退化成「只显示 HMS 码」，不给错文案。
/// 解析与查表在 JS 侧（`src/core/bambu-error-codes.js`，从 Electron 版原样保留），
/// 这里只负责「把表弄到手」。
///
/// Tauri 的 async command 必须返回 `Result`（带引用的 async command 不允许裸返回值），
/// 所以失败也包成 `Ok(None)`：这不是错误，只是「这台机器暂时没有码表」。
#[tauri::command]
pub async fn error_table(state: State<'_, Arc<AppState>>, serial: String) -> Result<Option<String>, String> {
    // 锁只用来读配置，取完立刻放掉：await 期间持有 MutexGuard 会让 future 失去 Send。
    let locale = state.cfg.lock().unwrap().locale.clone();
    let lang = crate::error_codes::lang_for(&locale);
    Ok(state.error_tables.table(&serial, lang).await)
}
