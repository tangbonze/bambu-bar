// Bambu Bar —— Tauri 2 跨平台版。
//
// 分层（与 Electron 版一致，只是换了执行环境）：
//   · 本 crate：配置 / 鉴权 / MQTT / 托盘 / 窗口 —— 全部 IO 与平台能力
//   · 前端 ui/：视图模型仍由从 Electron 版打包过来的 JS 核心计算（字段兼容逻辑只有一份）
//
// 这样做的直接收益：常驻内存从 Electron 的三进程（主进程 + GPU + renderer，150~300MB）
// 降到「一个 Rust 进程 + 按需的 WebView」。

pub mod auth;
pub mod commands;
pub mod config;
pub mod demo;
pub mod lan;
pub mod mqtt;
pub mod printer;
pub mod state;
pub mod tray;
pub mod windows;

use state::AppState;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// 把「打印机清单/偏好」的变更广播给所有窗口（前端据此重建快照）。
pub fn emit_bootstrap(app: &tauri::AppHandle, state: &Arc<AppState>) {
    let cfg = state.cfg.lock().unwrap().clone();
    let mut printers = Vec::new();
    if cfg.demo_mode {
        for (serial, name, model) in demo::entries() {
            printers.push(serde_json::json!({
                "serial": serial, "name": name, "model": model, "source": "cloud", "hidden": false,
            }));
        }
        let payload = serde_json::json!({
            "locale": cfg.locale,
            "demo": true,
            "printers": printers,
            "prefs": {
                "showTrayPercent": cfg.show_tray_percent,
                "panelWidth": cfg.panel_width,
                "theme": cfg.theme,
            },
            "account": { "loggedIn": true, "region": cfg.region, "account": "demo" },
        });
        let _ = app.emit("bootstrap", payload);
        return;
    }
    for p in &cfg.printers {
        printers.push(serde_json::json!({
            "serial": p.serial, "name": p.name, "model": p.model,
            "source": "cloud", "hidden": cfg.hidden_printers.contains(&p.serial),
        }));
    }
    for p in &cfg.lan_printers {
        printers.push(serde_json::json!({
            "serial": p.serial, "name": p.name, "model": p.model,
            "source": "lan", "host": p.host, "hidden": cfg.hidden_printers.contains(&p.serial),
        }));
    }
    let payload = serde_json::json!({
        "locale": cfg.locale,
        "demo": cfg.demo_mode,
        "printers": printers,
        "prefs": {
            "showTrayPercent": cfg.show_tray_percent,
            "panelWidth": cfg.panel_width,
            "theme": cfg.theme,
        },
        "account": {
            "loggedIn": cfg.account.as_ref().map(|a| !a.token.is_empty()).unwrap_or(false),
            "region": cfg.account.as_ref().map(|a| a.region.clone()).unwrap_or(cfg.region.clone()),
            "account": cfg.account.as_ref().map(|a| a.account.clone()).unwrap_or_default(),
        },
    });
    let _ = app.emit("bootstrap", payload);
}

/// 为清单里的每台机器起（或复用）一条 MQTT 连接。
///
/// 两条通道互相独立：
///   · 云端：需要登录令牌，跨网可用；
///   · 局域网：只需要 IP + 访问码，断外网也能看状态。
/// 同一台机器两边都配了也没关系——报文走同一套深度合并，谁先到用谁的。
pub fn start_connections(app: &tauri::AppHandle, state: &Arc<AppState>) {
    let cfg = state.cfg.lock().unwrap().clone();
    if cfg.demo_mode {
        return;
    }

    for p in &cfg.lan_printers {
        if p.host.trim().is_empty() || p.access_code.trim().is_empty() {
            continue;
        }
        if !state.claim(&format!("lan:{}", p.serial)) {
            continue;
        }
        lan::spawn(
            app.clone(),
            state.clone(),
            p.serial.clone(),
            p.host.trim().to_string(),
            p.access_code.trim().to_string(),
        );
    }

    let Some(account) = cfg.account.clone() else { return };
    if account.token.is_empty() {
        return;
    }
    let region = if account.region.is_empty() { cfg.region.clone() } else { account.region.clone() };
    let uid = account.uid.clone();

    for p in &cfg.printers {
        if !state.claim(&p.serial) {
            continue;
        }
        mqtt::spawn_cloud(
            app.clone(), state.clone(), p.serial.clone(),
            region.clone(), account.token.clone(), uid.clone(),
        );
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 菜单栏应用：不留 Dock 图标 / 任务栏项（Windows 由 skip_taskbar 处理）。
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let dir = app.path().app_config_dir()?;
            let cfg = config::Config::load(&dir);
            let state = AppState::new(cfg, dir);
            app.manage(state.clone());

            windows::create_popover(app.handle())?;
            windows::create_tray(app.handle(), state.clone())?;

            // `--demo`：临时演示，不写配置（排查/录屏用，不用去设置里来回勾）。
            let force_demo = std::env::args().any(|a| a == "--demo");
            if force_demo {
                state.cfg.lock().unwrap().demo_mode = true;
            }

            // 演示模式：造数据喂给菜单栏（面板用前端那份更完整的假数据）。
            if state.cfg.lock().unwrap().demo_mode {
                demo::start(app.handle(), &state);
            }

            // 托盘 1 秒节拍：轮播靠它推进（不能指望 MQTT 报文当计时器——
            // 暂停的机器可能几十秒才来一帧，轮播会「卡住」）。
            let handle = app.handle().clone();
            let st = state.clone();
            tauri::async_runtime::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(1));
                loop {
                    tick.tick().await;
                    tray::update(&handle, &st);
                }
            });

            start_connections(app.handle(), &state);
            tray::update(app.handle(), &state);

            // 开发/截图用：`bambu-bar --panel` 启动后直接把面板弹出来，
            // 免得为了看一眼界面还得先用鼠标点托盘。
            if std::env::args().any(|a| a == "--panel") {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    windows::toggle_popover(&h);
                });
            }

            // `--settings` 直接打开设置窗（验证登录 / 局域网表单时不用去点托盘菜单）。
            if std::env::args().any(|a| a == "--settings") {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    windows::show_settings(&h);
                });
            }

            // 同一把锁只取一次：eprintln! 的参数从左到右求值，两次 lock() 会在
            // 第一把锁还没释放时就等第二把，直接死锁在启动路径上。
            let (demo, count) = {
                let c = state.cfg.lock().unwrap();
                (c.demo_mode, c.printers.len())
            };
            eprintln!(
                "[boot] Bambu Bar {} · {} {} · demo={} · printers={}",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH,
                demo,
                count
            );

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap,
            commands::set_panel_height,
            commands::hide_panel,
            commands::refresh_all,
            commands::refresh_one,
            commands::set_hidden,
            commands::rename_printer,
            commands::open_settings,
            commands::quit_app,
            commands::diagnostics,
            commands::login,
            commands::login_with_code,
            commands::request_sms,
            commands::reload_devices,
            commands::set_pref,
            commands::logout,
            commands::lan_discover,
            commands::lan_probe,
            commands::lan_add,
            commands::lan_remove,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Bambu Bar")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                // 关掉所有窗口不等于退出（菜单栏应用要一直活着）。
                api.prevent_exit();
            }
        });
}
