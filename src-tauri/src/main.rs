// Windows 下不弹控制台窗口（release 构建）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    bambu_bar_lib::run()
}
