// 窗口与托盘：弹出面板的创建、定位、隐藏；设置窗按需创建。

use crate::state::AppState;
use std::sync::Arc;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

pub const POPOVER_W: f64 = 400.0;
pub const POPOVER_H: f64 = 420.0;

pub fn create_tray(app: &AppHandle, state: Arc<AppState>) -> tauri::Result<()> {
    let refresh = MenuItemBuilder::with_id("refresh", "刷新全部").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "设置…").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出 Bambu Bar").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&refresh, &settings])
        .separator()
        .item(&quit)
        .build()?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))
        .expect("tray icon");

    let mut builder = TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Bambu Bar")
        .menu(&menu)
        .show_menu_on_left_click(false);

    #[cfg(target_os = "macos")]
    {
        // 模板图：跟随系统明暗自动反色，无需准备两套图标。
        builder = builder.icon_as_template(true);
    }

    builder
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "refresh" => {
                let st = app.state::<Arc<AppState>>().inner().clone();
                for item in st.tray_items() {
                    st.request_pushall(&item.serial);
                }
            }
            "settings" => show_settings(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_popover(tray.app_handle());
            }
        })
        .build(app)?;

    let _ = state;
    Ok(())
}

pub fn create_popover(app: &AppHandle) -> tauri::Result<()> {
    let win = WebviewWindowBuilder::new(app, "popover", WebviewUrl::App("index.html".into()))
        .title("Bambu Bar")
        .inner_size(POPOVER_W, POPOVER_H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .shadow(true)
        .on_page_load(|_w, payload| {
            // 只在调试开关下打：页面到底有没有加载成功，是排查「面板空白 / 不测量高度」
            // 的第一现场——没有这行，失败在 WebKit 控制台里完全看不见。
            if std::env::var_os("BAMBU_BAR_DEBUG_TRAY").is_some() {
                eprintln!("[webview] {:?} {}", payload.event(), payload.url());
            }
        })
        .build()?;

    // 失焦即收起：菜单栏面板的通行行为（点别处等于关闭）。
    let w = win.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            let _ = w.hide();
        }
    });
    Ok(())
}

pub fn toggle_popover(app: &AppHandle) {
    let Some(win) = app.get_webview_window("popover") else {
        eprintln!("[panel] popover 窗口不存在");
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    position_near_tray(app, &win);
    let _ = win.show();
    let _ = win.set_focus();
}

/// 把面板贴到托盘图标下方（macOS 菜单栏）。
/// Windows/Linux 上 rect() 也实现了；拿不到就退化成鼠标位置。
fn position_near_tray(app: &AppHandle, win: &tauri::WebviewWindow) {
    let mut x = None;
    let mut y = None;

    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(Some(rect)) = tray.rect() {
            let scale = win.scale_factor().unwrap_or(1.0);
            let pos = rect.position.to_logical::<f64>(scale);
            let size = rect.size.to_logical::<f64>(scale);
            x = Some(pos.x + size.width / 2.0 - POPOVER_W / 2.0);
            y = Some(pos.y + size.height + 6.0);
        }
    }

    if x.is_none() || y.is_none() {
        if let Ok(p) = app.cursor_position() {
            let scale = win.scale_factor().unwrap_or(1.0);
            x = Some(p.x / scale - POPOVER_W / 2.0);
            y = Some(p.y / scale + 10.0);
        }
    }

    // 贴边收敛：面板不能跑出屏幕
    if let (Some(px), Some(py)) = (x, y) {
        let (mut px, mut py) = (px, py);
        if let Ok(Some(monitor)) = win.current_monitor() {
            let scale = monitor.scale_factor();
            let size = monitor.size().to_logical::<f64>(scale);
            let pos = monitor.position().to_logical::<f64>(scale);
            px = px.clamp(pos.x + 8.0, pos.x + size.width - POPOVER_W - 8.0);
            py = py.clamp(pos.y + 8.0, pos.y + size.height - 120.0);
        }
        let _ = win.set_position(tauri::LogicalPosition::new(px, py));
    }
}

pub fn show_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Bambu Bar 设置")
        .inner_size(580.0, 840.0)
        .min_inner_size(480.0, 560.0)
        .resizable(true)
        .build();
}
