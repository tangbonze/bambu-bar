//! 官方 HMS / 设备错误码表（BambuStudio 的 `resources/hms/hms_<lang>_<代号>.json`）。
//!
//! 表里两张子表，索引口径和打印机报文一致：
//!   · `device_error`：8 位 hex 的**失败原因码**，对应报文 `fail_reason`
//!     （如 0300400C = 任务已取消、07038012 = AMS 映射表获取失败）；
//!   · `device_hms`： 16 位 hex 的**硬件告警码**，对应报文 `hms[].attr`（高 8 位）
//!     + `hms[].code`（低 8 位）。
//!
//! 有了它，「打印失败」旁边才能显示官方那句中文，而不是光一个 HMS 码。
//!
//! ## 代号从哪来
//!
//! 机型代号 = **序列号前 3 位**（真机取证：01P00C560200187 → `01P`、
//! 03919B610800044 → `039`、20P6BJ… → `20P`），码表文件名就是 `hms_<lang>_<代号>.json`。
//!
//! ## 取表顺序（先本地后网络，命中即止）
//!
//! 1. BambuStudio 运行时缓存：`~/Library/Application Support/BambuStudio/hms/`
//! 2. BambuStudio 安装包内置：`/Applications/BambuStudio.app/Contents/Resources/hms/`
//! 3. 自己下载后缓存在应用配置目录的 `error-codes/` 下
//! 4. GitHub 上的 BambuStudio 仓库（只有 7 个代号，兜底 X1 等新型号）
//!
//! 1、2 两步是**离线**的，而且表最全——P1 / A1 的代号在 GitHub 上根本没有，
//! 只有装了 BambuStudio 才拿得到「自己机型的中文表」。
//!
//! 拿不到就返回 `None`：前端退回「只显示 HMS 码」。宁可少说一句，也不能给错文案。

use std::path::{Path, PathBuf};
use std::time::Duration;

/// BambuStudio 仓库里码表的 raw 地址（只覆盖 7 个代号，当最后兜底用）。
const RAW_BASE: &str = "https://raw.githubusercontent.com/bambulab/BambuStudio/master/resources/hms";

/// 序列号前 3 位即机型代号。
///
/// 只认 ASCII 字母数字：序列号是设备烧的，不会出现别的字符；过滤一下是为了
/// 挡住「序列号还没拿到、传了空串或占位符」这种脏输入——那种情况宁可返回
/// None 让前端显示原始 HMS 码，也不要去猜一个代号然后下错表。
pub fn model_code(serial: &str) -> Option<String> {
    let code: String = serial.trim().chars().take(3).collect();
    if code.len() < 3 {
        return None;
    }
    if !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(code.to_ascii_uppercase())
}

/// app locale → 码表语言段（文件名里的 `<lang>`）。中文走 `zh-cn`，其余走 `en`。
pub fn lang_for(locale: &str) -> &'static str {
    if locale.trim().to_ascii_lowercase().starts_with("zh") {
        "zh-cn"
    } else {
        "en"
    }
}

/// 码表文件名。
pub fn file_name(lang: &str, code: &str) -> String {
    format!("hms_{lang}_{code}.json")
}

/// BambuStudio 存放/内置码表的目录，按「最可能命中」排序。
///
/// 用户数据目录里的表是 BambuStudio 运行时从服务器拉的，**覆盖 GitHub 上没有的
/// 机型**（P1 = 01P、A1 = 039 都不在仓库的 7 个代号里），所以排在最前面。
fn local_hms_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        dirs.push(home.join("Library/Application Support/BambuStudio/hms")); // macOS
        dirs.push(home.join(".config/BambuStudio/hms")); // Linux (XDG config)
        dirs.push(home.join(".local/share/BambuStudio/hms")); // Linux (XDG data)
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("BambuStudio/hms")); // Windows
    }
    // 安装包内置（macOS 的 .app 里带 7 个代号 × 16 种语言）
    dirs.push(PathBuf::from("/Applications/BambuStudio.app/Contents/Resources/hms"));
    if let Ok(pf) = std::env::var("ProgramFiles") {
        dirs.push(PathBuf::from(pf).join("BambuStudio/resources/hms"));
    }
    dirs.push(PathBuf::from("/usr/share/bambulab-studio/hms"));
    dirs.push(PathBuf::from("/opt/bambulab-studio/hms"));
    dirs
}

fn read_to_string(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// 缓存写入失败不影响本次使用（表已经在内存里了）。
fn write_cache(path: &Path, body: &str) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, body);
}

/// 码表获取器。持有自己的缓存目录与 HTTP 客户端，可跨多次调用复用。
pub struct ErrorTables {
    cache_dir: PathBuf,
    client: reqwest::Client,
    /// 已确认「本地没有、GitHub 上也没有」的表（404）。
    /// 记下来是为了别每次启动都去撞一次网络——X1C / A1 mini 这些代号的表
    /// 只有装了 BambuStudio 才有，GitHub 上永远没有。
    missing: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl ErrorTables {
    pub fn new(cache_dir: PathBuf) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("BambuBar/1.0")
            .build()
            .unwrap_or_default();
        Self {
            cache_dir,
            client,
            missing: std::sync::Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// 取某台机器的官方码表**原始 JSON**（整份，含所有语言段）。
    ///
    /// 只做「取表」，不解析：解析与查表在 JS 侧（`src/core/bambu-error-codes.js`，
    /// 从 Electron 版原样保留），保持逻辑只有一份。
    pub async fn table(&self, serial: &str, lang: &str) -> Option<String> {
        let code = model_code(serial)?;
        let file = file_name(lang, &code);
        let miss_key = format!("{lang}_{code}");
        if self.missing.lock().unwrap().contains(&miss_key) {
            return None;
        }

        // 本地查找是同步 IO（文件最大 ~1.5MB），丢到 blocking 线程池里跑，
        // 别把异步运行时堵住——面板此时可能正在等报文渲染。
        let own_cache = self.cache_dir.join(&file);
        let dirs = local_hms_dirs();
        let probe = file.clone();
        let local = tokio::task::spawn_blocking(move || {
            if let Some(text) = read_to_string(&own_cache) {
                return Some((text, "自有缓存".to_string()));
            }
            for dir in &dirs {
                let p = dir.join(&probe);
                if let Some(text) = read_to_string(&p) {
                    return Some((text, p.display().to_string()));
                }
            }
            None
        })
        .await
        .ok()
        .flatten();
        if let Some((text, from)) = local {
            debug(&format!("{file} ← {from}"));
            return Some(text);
        }

        // 本地没有才走网络。reqwest 默认读 HTTPS_PROXY / ALL_PROXY 环境变量，
        // 国内网络下需要代理时设上即可（Electron 版靠 Electron net 读系统代理）。
        let url = format!("{RAW_BASE}/{file}");
        let resp = self.client.get(&url).send().await.ok()?;
        let status = resp.status();
        if !status.is_success() {
            // 404 = 这个机型根本没有这张表（GitHub 上只内置了 7 个型号）。
            // 记进负缓存，别每次启动都去撞一次；超时/网络错误不记，下次还能重试。
            if status == reqwest::StatusCode::NOT_FOUND {
                self.missing.lock().unwrap().insert(miss_key);
                debug(&format!("{file} ← GitHub 404（该机型没有官方表）"));
            }
            return None;
        }
        let body = resp.text().await.ok()?;
        write_cache(&self.cache_dir.join(&file), &body);
        debug(&format!("{file} ← GitHub（已存进自有缓存）"));
        Some(body)
    }
}

/// 调试日志只在 BAMBU_BAR_DEBUG_TRAY=1 时输出，跟托盘调试同一个开关。
fn debug(msg: &str) {
    if std::env::var_os("BAMBU_BAR_DEBUG_TRAY").is_some() {
        eprintln!("[error-codes] {msg}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_code_is_the_first_three_chars() {
        // 真机序列号
        assert_eq!(model_code("01P00C560200187").as_deref(), Some("01P"));
        assert_eq!(model_code("03919B610800044").as_deref(), Some("039"));
        assert_eq!(model_code("20P6BJ000000000").as_deref(), Some("20P"));
        assert_eq!(model_code("  01P00C560200187  ").as_deref(), Some("01P"));
    }

    #[test]
    fn dirty_serial_yields_no_code() {
        // 空串、太空、太短、带非 ASCII —— 都不要去猜代号
        assert_eq!(model_code(""), None);
        assert_eq!(model_code("  "), None);
        assert_eq!(model_code("01"), None);
        assert_eq!(model_code("01 中文"), None);
    }

    #[test]
    fn lang_follows_locale() {
        assert_eq!(lang_for("zh-CN"), "zh-cn");
        assert_eq!(lang_for("zh"), "zh-cn");
        assert_eq!(lang_for("ZH_CN"), "zh-cn");
        assert_eq!(lang_for("en-US"), "en");
        assert_eq!(lang_for(""), "en");
    }

    #[test]
    fn file_name_matches_bambu_studio_layout() {
        assert_eq!(file_name("zh-cn", "01P"), "hms_zh-cn_01P.json");
        assert_eq!(file_name("en", "093"), "hms_en_093.json");
    }

    #[tokio::test]
    async fn own_cache_wins_and_needs_no_network() {
        // 用临时目录当自己的缓存：放进去一份假表，table() 必须直接命中它，
        // 而且不能去碰网络——本地优先是这套取表逻辑的核心（装了 BambuStudio 的机器
        // 大概率连不上 GitHub）。
        let dir = std::env::temp_dir().join(format!("bb-hms-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("hms_zh-cn_01P.json"), "{\"data\":{}}").unwrap();

        let tables = ErrorTables::new(dir.clone());
        let got = tables.table("01P00C560200187", "zh-cn").await;
        assert_eq!(got.as_deref(), Some("{\"data\":{}}"));

        // 序列号不对 → 拼不出代号 → 直接没有表，不去瞎猜
        assert_eq!(tables.table("", "zh-cn").await, None);
        assert_eq!(tables.table("0", "zh-cn").await, None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_table_returns_none() {
        // 干净目录 + 一个本地一定没有的代号 → 不联网也能快速返回 None。
        // （真去网络也没关系：GitHub 上没有这个文件，404 → None）
        let dir = std::env::temp_dir().join(format!("bb-hms-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let tables = ErrorTables::new(dir.clone());
        assert_eq!(tables.table("ZZZ00C560200187", "zh-cn").await, None);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
