// Runs at compile time: reads tauri.conf.json, embeds icons/resources,
// generates the capability schemas under gen/. Standard Tauri boilerplate.
fn main() {
    tauri_build::build()
}
