// Windows: without this line a release build opens a black console window
// next to the app. Debug builds keep the console so `println!` is visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    braindump_lite_lib::run();
}
