// 偏好持久化：单个 JSON 文件，放在系统标准配置目录。
//
// 与 Electron 版的差别：electron-store 存的是同一份结构，这里保持字段名一致，
// 方便用户从旧版迁移（把旧 config.json 直接拷过来即可）。
//
// ⚠️ 凭据（云端 token / 局域网 access code）目前以 0600 权限明文落盘。
//    Electron 版用的是系统钥匙串（safeStorage），跨平台对齐钥匙串需要每个平台
//    一套后端（macOS Keychain / Windows Credential Manager / libsecret），
//    留到后续版本，这里先把文件权限收紧，不让其他用户读到。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Account {
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub uid: String,
    #[serde(default)]
    pub account: String,
    #[serde(default)]
    pub region: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrinterEntry {
    pub serial: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanPrinter {
    pub serial: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub access_code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_locale")]
    pub locale: String,
    /// 'global' | 'china'
    #[serde(default = "default_region")]
    pub region: String,
    #[serde(default)]
    pub account: Option<Account>,
    #[serde(default)]
    pub printers: Vec<PrinterEntry>,
    #[serde(default)]
    pub lan_printers: Vec<LanPrinter>,
    #[serde(default)]
    pub hidden_printers: Vec<String>,
    #[serde(default = "default_true")]
    pub show_tray_percent: bool,
    #[serde(default = "default_true")]
    pub notify: bool,
    #[serde(default = "default_panel_width")]
    pub panel_width: f64,
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 演示模式：用内置假数据跑通全链路，不连任何网络。
    #[serde(default)]
    pub demo_mode: bool,
}

fn default_locale() -> String { "zh-CN".into() }
fn default_region() -> String { "global".into() }
fn default_true() -> bool { true }
fn default_panel_width() -> f64 { 400.0 }
fn default_theme() -> String { "system".into() }

impl Default for Config {
    fn default() -> Self {
        Self {
            locale: default_locale(),
            region: default_region(),
            account: None,
            printers: Vec::new(),
            lan_printers: Vec::new(),
            hidden_printers: Vec::new(),
            show_tray_percent: true,
            notify: true,
            panel_width: default_panel_width(),
            theme: default_theme(),
            demo_mode: false,
        }
    }
}

impl Config {
    pub fn path(dir: &Path) -> PathBuf {
        dir.join("config.json")
    }

    /// 读配置；文件缺失/损坏一律回退默认值并保留原文件（改名为 .bak），绝不因为
    /// 一份坏 JSON 就打不开应用。
    pub fn load(dir: &Path) -> Self {
        let p = Self::path(dir);
        let Ok(text) = fs::read_to_string(&p) else {
            return Self::default();
        };
        match serde_json::from_str::<Config>(&text) {
            Ok(mut c) => {
                if c.locale.is_empty() { c.locale = default_locale(); }
                if c.region.is_empty() { c.region = default_region(); }
                c
            }
            Err(e) => {
                eprintln!("[config] 解析失败，回退默认值: {e}");
                let _ = fs::rename(&p, p.with_extension("json.bak"));
                Self::default()
            }
        }
    }

    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        fs::create_dir_all(dir)?;
        let p = Self::path(dir);
        let tmp = p.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
        fs::rename(&tmp, &p)?;
        Ok(())
    }
}
