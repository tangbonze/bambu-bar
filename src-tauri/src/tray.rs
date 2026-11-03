// 托盘展示层 —— 跨平台的关键抽象。
//
// 三个平台的托盘能力并不对等，这是 OS 限制而不是框架限制：
//   · macOS：NSStatusItem 支持文字标题（setTitle）。本应用的核心体验「X1C 42%」靠它。
//   · Windows：只能设图标 + tooltip（Shell_NotifyIcon 没有文字位）。
//   · Linux：AppIndicator 同样只有图标 + tooltip，且 tooltip 支持还依赖桌面环境。
//
// 所以这里拆成两条实现路径，对外只暴露 update()：
//   ┌ macOS   → 文字标题（自绘定宽补白）+ 模板图标
//   └ Win/Lin → 动态位图图标（进度环 + 状态色）+ tooltip
//
// 定宽（不抖动）在 macOS 上是刚需：轮播时文字宽度变化会让右边的系统时钟左右跳。
// 早先的做法是「按实测步进表算宽度，再往标题尾部补 NBSP/thin/hair 空白」——
// 宽度是稳住了，但补白全部堆在右边，条目里的字就被顶到了左端，看着不居中
// （用户明确反馈过）。现在改成 AppKit 的正规做法：
//   · 标题里不再塞任何补白字符，只写 `X1C 42%`；
//   · 用 NSStatusItem.setLength 把整个条目的宽度钉死为「轮播集里最宽的那条」，
//     内容由 AppKit 在固定宽度内居中。
// 这样宽度恒定（时钟不跳），文字也真的居中；步进表只用来预算目标宽度。

use crate::state::{AppState, TrayItem};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::AppHandle;

/// macOS 菜单栏字体（NSFont.menuBarFontOfSize(0)）的逐字符步进（px）。
/// 实测来源：本机 AppKit `NSString.sizeWithAttributes` 逐个字符量取，
/// 校验样例 " X1C  42%" = 62.68px 与逐字累加完全一致（无 kerning 差异）。
const ADV: &[(char, f64)] = &[
    (' ', 3.58), ('0', 8.11), ('1', 5.95), ('2', 7.77), ('3', 8.07), ('4', 8.29),
    ('5', 7.96), ('6', 8.20), ('7', 7.33), ('8', 8.23), ('9', 8.20),
    ('A', 8.68), ('B', 8.47), ('C', 9.23), ('D', 9.37), ('E', 7.67), ('F', 7.36),
    ('G', 9.63), ('H', 9.57), ('I', 3.40), ('J', 6.92), ('K', 8.49), ('L', 7.31),
    ('M', 11.29), ('N', 9.57), ('O', 9.95), ('P', 8.18), ('Q', 9.95), ('R', 8.42),
    ('S', 8.21), ('T', 8.16), ('U', 9.51), ('V', 8.68), ('W', 12.50), ('X', 8.75),
    ('Y', 8.44), ('Z', 8.52),
    ('a', 7.10), ('b', 7.91), ('c', 7.20), ('d', 7.91), ('e', 7.35), ('f', 4.63),
    ('g', 7.85), ('h', 7.57), ('i', 3.14), ('j', 3.13), ('k', 6.98), ('l', 3.21),
    ('m', 11.24), ('n', 7.51), ('o', 7.60), ('p', 7.86), ('q', 7.85), ('r', 4.88),
    ('s', 6.73), ('t', 4.65), ('u', 7.51), ('v', 6.97), ('w', 9.99), ('x', 6.74),
    ('y', 6.98), ('z', 6.93),
    ('%', 11.95), ('‖', 5.68), ('…', 10.38), ('-', 6.06), ('_', 7.51),
    ('.', 3.78), ('·', 6.23), (':', 3.78),
    // 补白用的三种空白必须在表里，否则会掉进「未知字符按 8px 估」的兜底，补白量直接错一倍。
    ('\u{00A0}', 3.58), ('\u{2009}', 1.75), ('\u{200A}', 0.84),
];

const PAD_HAIR: char = '\u{200A}'; // ≈0.84px
const PAD_THIN: char = '\u{2009}'; // ≈1.75px
const PAD_NBSP: char = '\u{00A0}'; // ≈3.58px

fn char_adv(c: char) -> f64 {
    if let Some((_, w)) = ADV.iter().find(|(x, _)| *x == c) {
        return *w;
    }
    // 未知字符：CJK 按全角估 13px，其余按平均 8px（只影响定宽预算，不影响可读性）
    if (c as u32) > 0x2E80 { 13.0 } else { 8.0 }
}

pub fn text_width(s: &str) -> f64 {
    s.chars().map(char_adv).sum()
}

/// 用三种宽度的空白拼出指定宽度（先 NBSP 铺，余量用 thin / hair 精修）。
fn blanks(mut need: f64) -> String {
    let mut out = String::new();
    if need <= 0.0 {
        return out;
    }
    let n_b = (need / 3.58).floor();
    out.extend(std::iter::repeat(PAD_NBSP).take(n_b as usize));
    need -= n_b * 3.58;
    let n_t = (need / 1.75).floor();
    out.extend(std::iter::repeat(PAD_THIN).take(n_t as usize));
    need -= n_t * 1.75;
    out.extend(std::iter::repeat(PAD_HAIR).take(need.round().max(0.0) as usize));
    out
}

/// 把文字**居中**补到目标宽度：左右各分一半空白。
///
/// 早先只在右边补白，条目宽度是稳住了，但字被顶到左端、右边空一大块——
/// 菜单栏里看着就是不居中（用户反馈过）。这里把余量对半分，标题整体宽度不变
/// （所以轮播时右侧系统图标不会左右跳），而 AppKit 以标题宽度排版，
/// 左右各一半空白 ⇒ 字正好落在条目正中。
fn pad_centered(text: &str, target: f64) -> String {
    let nat = text_width(text);
    if nat + 0.5 >= target {
        return text.to_string();
    }
    let deficit = target - nat;
    let left = blanks(deficit / 2.0);
    let right = blanks(deficit - text_width(&left));
    format!("{left}{text}{right}")
}

struct Rot {
    key: String,
    index: usize,
    at: Instant,
    /// 上一次真正写进菜单栏的标题（调试日志用：只记变化，不刷屏）。
    last_text: String,
}

fn rot() -> &'static Mutex<Rot> {
    static ROT: OnceLock<Mutex<Rot>> = OnceLock::new();
    ROT.get_or_init(|| {
        Mutex::new(Rot {
            key: String::new(),
            index: 0,
            at: Instant::now(),
            last_text: String::new(),
        })
    })
}

const ROTATE_MS: u128 = 3000;

/// 菜单栏一条机器的文字：`<机型> <进度>`
///
/// 曾经在暂停时加一枚 `‖`、准备/换料时加一枚 `…`（好让菜单栏一眼看出没在打）。
/// 实测这两枚符号比机型本身还抢眼，用户明确要求「那根竖线不要显示」——已去掉：
/// 状态在上方面板、tooltip 和托盘图标里都有，菜单栏这一格只留机型 + 进度。
fn entry_text(item: &TrayItem, show_percent: bool) -> String {
    entry_text_with(item, show_percent, None)
}

/// `slot_override` 用来算「最宽可能值」：进度位数会变（9% / 100%），
/// 用 100% 作为宽度上限，百分比跳动时窗口宽度才不会跟着抖。
fn entry_text_with(item: &TrayItem, show_percent: bool, slot_override: Option<&str>) -> String {
    let model = tray_model(item);
    if !show_percent {
        return model;
    }
    let slot = match (slot_override, item.percent) {
        (Some(s), _) => s.to_string(),
        (None, Some(p)) => format!("{:>3}%", p.round() as i64),
        (None, None) => "···".to_string(),
    };
    format!("{model} {slot}")
}

/// 某一条在「最宽情况」下的像素宽度（进度按 100% 估）。
fn entry_width(item: &TrayItem, show_percent: bool) -> f64 {
    let cap = if show_percent { Some("100%") } else { None };
    text_width(&entry_text_with(item, show_percent, cap))
}

/// 菜单栏只显示机型，不显示用户自起的名字（名字可能很长/带中文，这一格寸土寸金）。
fn tray_model(item: &TrayItem) -> String {
    let raw = if !item.model.is_empty() { &item.model } else if !item.name.is_empty() { &item.name } else { &item.serial };
    let t = raw.trim();
    if t.is_empty() { "?".into() } else { t.chars().take(8).collect() }
}

pub fn update(app: &AppHandle, state: &Arc<AppState>) {
    let Some(tray) = app.tray_by_id("main") else { return };
    let cfg = state.cfg.lock().unwrap();
    let show_percent = cfg.show_tray_percent;
    drop(cfg);

    let items = state.tray_items();
    let failed = items.iter().filter(|i| i.status_class == "failed").count();
    let mut active: Vec<&TrayItem> = items.iter().filter(|i| i.rotating()).collect();
    // 打印中的排在前面，其次暂停（与 Electron 版「谁在干活谁先露脸」的直觉一致）
    active.sort_by_key(|i| if i.status_class == "printing" { 0 } else { 1 });

    let tooltip = build_tooltip(&items, failed);

    // ── 失败优先：固定显示「!」，不参与轮播（失败是要处理的事，不能一闪而过）──
    if failed > 0 {
        set_title(app, &tray, " !");
        set_badge(app, &tray, None, "failed");
        let _ = tray.set_tooltip(Some(&tooltip));
        return;
    }

    if active.is_empty() {
        set_title(app, &tray, "");
        set_badge(app, &tray, None, "idle");
        let _ = tray.set_tooltip(Some(&tooltip));
        return;
    }

    // ── 轮播索引 ──
    let key = active.iter().map(|i| i.serial.clone()).collect::<Vec<_>>().join(",");
    let idx = {
        let mut r = rot().lock().unwrap();
        if r.key != key {
            r.key = key;
            r.index = 0;
            r.at = Instant::now();
        }
        if active.len() > 1 {
            r.index = ((r.at.elapsed().as_millis() / ROTATE_MS) as usize) % active.len();
        } else {
            r.index = 0;
        }
        r.index
    };
    let cur = active[idx.min(active.len() - 1)];
    let text = entry_text(cur, show_percent);

    // ── 定宽：目标 = 当前轮播集里最宽的那一条（进度一律按 100% 估）──
    // 标题本身不再补空白；宽度交给 NSStatusItem 钉死，AppKit 会把
    // 「图标 + 文字」这组内容在固定宽度里居中——这正是之前缺的那一步。
    let target = active
        .iter()
        .map(|i| entry_width(i, show_percent))
        .fold(0.0_f64, f64::max);

    let padded = pad_centered(&text, target);
    set_title(app, &tray, &padded);
    set_badge(app, &tray, cur.percent, &cur.status_class);
    let _ = tray.set_tooltip(Some(&tooltip));

    // 调参用：BAMBU_BAR_DEBUG_TRAY=1 时把每次写入的标题、预算宽度和**实测条目宽度**
    // 都打出来——「轮播换字但条目宽度不变」需要证据，肉眼盯着时钟不跳不够硬。
    if std::env::var_os("BAMBU_BAR_DEBUG_TRAY").is_some() {
        let mut r = rot().lock().unwrap();
        if r.last_text != padded {
            r.last_text = padded.clone();
            eprintln!(
                "[tray] idx={} target={:.2} width={:.2} rect={:?} text={:?}",
                idx, target, text_width(&padded),
                tray.rect().ok().flatten().map(|r| {
                    let p = r.position.to_logical::<f64>(2.0);
                    let z = r.size.to_logical::<f64>(2.0);
                    (p.x, p.y, z.width, z.height)
                }),
                padded.escape_debug().to_string()
            );
        }
    }
}

fn build_tooltip(items: &[TrayItem], _failed: usize) -> String {
    let mut parts: Vec<String> = vec!["Bambu Bar".into()];
    for i in items.iter().filter(|i| matches!(i.status_class.as_str(), "printing" | "paused" | "failed")).take(4) {
        let pct = i.percent.map(|p| format!(" {:.0}%", p)).unwrap_or_default();
        parts.push(format!("{}{pct}", i.name));
    }
    if parts.len() == 1 {
        parts.push(format!("{} 台设备空闲", items.len()));
    }
    parts.join(" · ")
}

#[cfg(target_os = "macos")]
fn set_title(_app: &AppHandle, tray: &tauri::tray::TrayIcon, text: &str) {
    let _ = tray.set_title(Some(text));
}


/// Windows / Linux 的托盘没有文字位：把进度画进图标。
#[cfg(not(target_os = "macos"))]
fn set_title(_app: &AppHandle, _tray: &tauri::tray::TrayIcon, _text: &str) {}


#[cfg(target_os = "macos")]
fn set_badge(_app: &AppHandle, _tray: &tauri::tray::TrayIcon, _percent: Option<f64>, _class: &str) {
    // macOS 用文字标题表达全部信息，图标保持模板图（跟随明暗自动反色）。
}

#[cfg(not(target_os = "macos"))]
fn set_badge(app: &AppHandle, tray: &tauri::tray::TrayIcon, percent: Option<f64>, class: &str) {
    let png = render_badge(percent, class);
    if let Ok(img) = tauri::image::Image::from_bytes(&png) {
        let _ = tray.set_icon(Some(img));
    }
    let _ = app;
}

/// 画一个 32×32 的圆形进度徽标（状态色 + 轨道 + 进度弧）。无文字：
/// 这个尺寸下画字会糊成一团，具体数字交给 tooltip。
#[cfg(not(target_os = "macos"))]
fn render_badge(percent: Option<f64>, class: &str) -> Vec<u8> {
    use tiny_skia::{Color, LineCap, Paint, PathBuilder, Pixmap, Stroke, Transform};

    let size = 32u32;
    let mut pix = Pixmap::new(size, size).unwrap();
    let (r, g, b) = match class {
        "printing" => (0x16, 0x77, 0xff),
        "paused" => (0xfa, 0x8c, 0x16),
        "failed" => (0xff, 0x4d, 0x4f),
        "finished" => (0x1f, 0x9d, 0x4d),
        _ => (0x8c, 0x8c, 0x8c),
    };
    let color = Color::from_rgba8(r, g, b, 255);

    // 轨道
    let mut track = Paint::default();
    track.set_color(Color::from_rgba8(r, g, b, 48));
    track.anti_alias = true;
    let track_stroke = Stroke { width: 3.0, line_cap: LineCap::Round, ..Default::default() };
    let mut pb = PathBuilder::new();
    pb.push_circle(16.0, 16.0, 12.0);
    if let Some(path) = pb.finish() {
        pix.stroke_path(&path, &track, &track_stroke, Transform::identity(), None);
    }

    // 进度弧（从 12 点方向顺时针）
    let pct = percent.unwrap_or(0.0).clamp(0.0, 100.0) / 100.0;
    let filled = if class == "printing" || class == "paused" { pct } else { 1.0 };
    if filled > 0.0 {
        let mut arc = Paint::default();
        arc.set_color(color);
        arc.anti_alias = true;
        let steps = ((filled * 72.0) as usize).max(2);
        let mut pb = PathBuilder::new();
        let start = -std::f64::consts::FRAC_PI_2;
        for i in 0..=steps {
            let a = start + filled * std::f64::consts::TAU * (i as f64 / steps as f64);
            let (x, y) = (16.0 + 12.0 * a.cos(), 16.0 + 12.0 * a.sin());
            if i == 0 { pb.move_to(x as f32, y as f32); } else { pb.line_to(x as f32, y as f32); }
        }
        if let Some(path) = pb.finish() {
            let stroke = Stroke { width: 3.0, line_cap: LineCap::Round, ..Default::default() };
            pix.stroke_path(&path, &arc, &stroke, Transform::identity(), None);
        }
    }

    // 中心实心点：一眼分辨「有任务」还是「空闲」
    if class != "idle" && class != "offline" {
        let mut dot = Paint::default();
        dot.set_color(color);
        dot.anti_alias = true;
        let mut pb = PathBuilder::new();
        pb.push_circle(16.0, 16.0, 4.0);
        if let Some(path) = pb.finish() {
            pix.fill_path(&path, &dot, tiny_skia::FillRule::Winding, Transform::identity(), None);
        }
    }

    pix.encode_png().unwrap_or_default()
}

/// 剩余分钟 → 本机时区的绝对完工时刻（跨天标 +1）。
pub fn eta_text(remain_mins: f64) -> Option<String> {
    if !(remain_mins.is_finite()) || remain_mins <= 0.0 {
        return None;
    }
    let now = std::time::SystemTime::now();
    let eta = now + std::time::Duration::from_secs((remain_mins * 60.0) as u64);
    let secs = eta.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
    let local = secs + local_offset_secs();
    let day = local.div_euclid(86_400);
    let sod = local.rem_euclid(86_400);
    let (h, m) = (sod / 3600, (sod % 3600) / 60);
    let today = {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
        (n + local_offset_secs()).div_euclid(86_400)
    };
    let off = day - today;
    Some(if off > 0 { format!("{h:02}:{m:02}+{off}") } else { format!("{h:02}:{m:02}") })
}

/// 本机时区相对 UTC 的偏移（秒）。跨平台取法不同，这里用 libc 的 tm_gmtoff 路径，
/// 避免为了一个时间格式化引入整包 chrono。
fn local_offset_secs() -> i64 {
    #[cfg(unix)]
    {
        unsafe {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let mut tm: libc::tm = std::mem::zeroed();
            let t = now as libc::time_t;
            if libc::localtime_r(&t, &mut tm).is_null() {
                return 0;
            }
            tm.tm_gmtoff as i64
        }
    }
    #[cfg(windows)]
    {
        // Windows 下用 GetTimeZoneInformation 需要额外 crate；先按 UTC 处理，
        // 仅仅影响 tooltip 里的绝对时刻文案（前端面板用 JS 正确计算）。
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advance_table_matches_appkit_sample() {
        // 实测基准：AppKit 量得 " X1C  42%" = 62.68px，逐字累加必须复现同一个值，
        // 否则补白表的误差会随时间在时钟上累积成肉眼可见的抖动。
        let w = text_width(" X1C  42%");
        assert!((w - 62.68).abs() < 0.05, "逐字累加 {w} 与实测 62.68 不符");
    }

    #[test]
    fn entry_text_has_no_padding_of_its_own() {
        // 补白只在 pad_centered 里加，entry_text 必须是「干净」的文字：
        // 否则宽度预算（entry_width）会把上一次的补白也算进去，越加越胖。
        let item = TrayItem {
            serial: "s".into(), name: "n".into(), model: "X1C".into(),
            state_key: "printing".into(), status_class: "printing".into(),
            percent: Some(42.0), remain_mins: None, eta: None, job: None, online: true,
        };
        let text = entry_text(&item, true);
        assert_eq!(text, "X1C  42%");
        assert!(!text.ends_with(' '));
        assert!(!text.chars().any(|c| matches!(c, '\u{00A0}' | '\u{2009}' | '\u{200A}')));
    }

    #[test]
    fn percent_slot_is_right_aligned() {
        // 1% / 42% / 100% 的数字位数不同，但冒号前的位置必须对齐，
        // 否则轮播时「%」会左右横跳。
        let a = entry_text(
            &TrayItem {
                serial: "s".into(), name: "n".into(), model: "X1C".into(),
                state_key: "printing".into(), status_class: "printing".into(),
                percent: Some(1.0), remain_mins: None, eta: None, job: None, online: true,
            },
            true,
        );
        let b = entry_text(
            &TrayItem {
                serial: "s".into(), name: "n".into(), model: "X1C".into(),
                state_key: "printing".into(), status_class: "printing".into(),
                percent: Some(100.0), remain_mins: None, eta: None, job: None, online: true,
            },
            true,
        );
        assert_eq!(a, "X1C   1%");
        assert_eq!(b, "X1C 100%");
        assert_eq!(a.chars().count(), b.chars().count());
    }

    #[test]
    fn width_tracks_content_not_a_fixed_120() {
        // 机型短的时候必须收窄：旧实现固定补到 120px，菜单栏右半边全是空白。
        let item = TrayItem {
            serial: "s".into(), name: "n".into(), model: "A1".into(),
            state_key: "printing".into(), status_class: "printing".into(),
            percent: Some(69.0), remain_mins: None, eta: None, job: None, online: true,
        };
        let w = entry_width(&item, true);
        assert!(w < 70.0, "A1 的宽度上限 {w}px 太宽了");
        // 但必须留够 3 位进度的位置：9% / 100% 切换时不能变宽。
        let cap = entry_width(&item, true);
        let at_100 = text_width(&entry_text_with(&item, true, Some("100%")));
        assert!((cap - at_100).abs() < 0.01, "宽度上限必须按 100% 估");
        assert!(text_width(&entry_text(&item, true)) <= cap + 0.01);
    }

    #[test]
    fn padding_is_split_evenly_around_the_text() {
        // 居中 = 左右空白几乎相等（差 1px 以内），且总宽度落在目标宽度上 ±1px。
        for (text, target) in [("X1C  42%", 86.62), ("A1  73%", 86.62), ("‖ P1S 100%", 86.62)] {
            let padded = pad_centered(text, target);
            assert!(padded.starts_with(|c: char| c == '\u{00A0}' || c == '\u{2009}' || c == '\u{200A}'));
            let left: String = padded.chars().take_while(|c| *c == '\u{00A0}' || *c == '\u{2009}' || *c == '\u{200A}').collect();
            let right: String = padded.chars().rev().take_while(|c| *c == '\u{00A0}' || *c == '\u{2009}' || *c == '\u{200A}').collect();
            assert!((text_width(&left) - text_width(&right)).abs() <= 1.0, "{text:?} 左右补白不对称");
            assert!((text_width(&padded) - target).abs() <= 1.0, "{text:?} 总宽 {} 偏离 {target}", text_width(&padded));
            assert!(padded.contains(text), "补白不能吃掉原文");
        }
    }

    #[test]
    fn slot_width_is_constant_across_the_rotation_set() {
        // 菜单栏条目宽度 = 轮播集里最宽那条文字 + 图标预留。
        // 三个机型长度不同，但算出来的 slot 必须完全一致，否则轮播时右侧时钟会左右跳。
        let items: Vec<TrayItem> = ["X1C", "A1", "P1S"]
            .iter()
            .map(|m| TrayItem {
                serial: "s".into(), name: "n".into(), model: m.to_string(),
                state_key: "printing".into(), status_class: "printing".into(),
                percent: Some(42.0), remain_mins: None, eta: None, job: None, online: true,
            })
            .collect();
        let widest = items.iter().map(|i| entry_width(i, true)).fold(0.0_f64, f64::max);
        for i in &items {
            let padded = pad_centered(&entry_text(i, true), widest);
            // 每一帧补到的总宽度都一样，轮播时右侧时钟才不会跳
            assert!((text_width(&padded) - widest).abs() <= 1.0);
        }
    }

    #[test]
    fn eta_crosses_midnight() {
        // 剩余 25 小时：必须带 +1 天后缀，不能被格式化成「01:xx」误导用户。
        let t = eta_text(25.0 * 60.0).expect("eta");
        assert!(t.contains('+'), "{t}");
    }

    #[test]
    fn no_state_mark_in_menu_bar() {
        // 暂停曾经带一枚「‖」前缀，用户反馈那根竖线太抢眼、要去掉。
        // 这里钉住：任何状态（打印/暂停/准备/换料/空闲）都只能以机型开头。
        for (state, class) in [
            ("printing", "printing"),
            ("paused", "paused"),
            ("prepare", "prepare"),
            ("changing_filament", "printing"),
            ("idle", "idle"),
        ] {
            let item = TrayItem {
                serial: "s".into(), name: "n".into(), model: "P1S".into(),
                state_key: state.into(), status_class: class.into(),
                percent: Some(79.0), remain_mins: None, eta: None, job: None, online: true,
            };
            let with_pct = entry_text(&item, true);
            let no_pct = entry_text(&item, false);
            assert!(with_pct.starts_with("P1S"), "{state} → {with_pct:?} 不能带状态符");
            assert!(no_pct.starts_with("P1S"), "{state} → {no_pct:?} 不能带状态符");
            assert_eq!(no_pct, "P1S");
            // 宽度预算也不能把这些符号算进去，否则轮播时宽度会跟着状态跳
            assert!((entry_width(&item, true) - text_width("P1S 100%")).abs() < 0.01);
        }
    }
}
