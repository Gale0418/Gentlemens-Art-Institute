import re

with open("src/lib.rs", "r") as f:
    content = f.read()

# Add dummy show_item_in_folder for ios
if "#[cfg(target_os = \"ios\")]\nasync fn show_item_in_folder" not in content:
    content = content.replace("async fn browse_folders(dir_path: Option<String>) -> Result<serde_json::Value, String> {\n    Ok(serde_json::json!({ \"currentPath\": dir_path.unwrap_or_default(), \"folders\": [] }))\n}", "async fn browse_folders(dir_path: Option<String>) -> Result<serde_json::Value, String> {\n    Ok(serde_json::json!({ \"currentPath\": dir_path.unwrap_or_default(), \"folders\": [] }))\n}\n\n#[tauri::command]\n#[cfg(target_os = \"ios\")]\nasync fn show_item_in_folder(_path: String) -> Result<(), String> {\n    Ok(())\n}\n")

with open("src/lib.rs", "w") as f:
    f.write(content)

