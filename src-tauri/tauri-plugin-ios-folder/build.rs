const COMMANDS: &[&str] = &["pick_folder", "start_accessing", "stop_accessing"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
