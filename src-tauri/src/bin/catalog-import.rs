use app_lib::catalog::CatalogStore;
use app_lib::scanner::IMAGE_EXTENSIONS;
use app_lib::state::{ComicItem, Progress};
use base64::{engine::general_purpose, Engine as _};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use walkdir::{DirEntry, WalkDir};

fn visible(entry: &DirEntry) -> bool {
    entry
        .file_name()
        .to_str()
        .is_none_or(|name| !name.starts_with('.') && name != "__MACOSX" && name != "node_modules")
}

fn progress_for(progress: &HashMap<String, Progress>, id: &str) -> Progress {
    progress.get(id).cloned().unwrap_or(Progress {
        current_page: 0,
        total_pages: 0,
        percent: 0.0,
        updated_at: None,
    })
}

fn item_for_path(
    root: &Path,
    path: &Path,
    kind: &str,
    ext: &str,
    progress: &HashMap<String, Progress>,
) -> Result<ComicItem, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .into_owned();
    let id = general_purpose::URL_SAFE_NO_PAD.encode(relative.as_bytes());
    let updated_at = std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map(chrono::DateTime::<chrono::Utc>::from)
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());
    Ok(ComicItem {
        id: id.clone(),
        r#type: kind.to_string(),
        relative_path: relative,
        ext: ext.to_string(),
        title: path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Unknown")
            .to_string(),
        series: path
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .unwrap_or("未分類")
            .to_string(),
        updated_at,
        page_count: 0,
        progress: progress_for(progress, &id),
        source_id: format!(
            "local:{}",
            general_purpose::URL_SAFE_NO_PAD.encode(root.to_string_lossy().as_bytes())
        ),
        source_path: Some(path.to_string_lossy().into_owned()),
        external_bookmark: None,
    })
}

fn main() -> Result<(), String> {
    let mut args = std::env::args_os().skip(1);
    let root = args
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "用法：catalog-import <漫畫根目錄> <catalog.sqlite3>".to_string())?;
    let database = args
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "用法：catalog-import <漫畫根目錄> <catalog.sqlite3>".to_string())?;
    if args.next().is_some() || !root.is_dir() {
        return Err("漫畫根目錄不存在或參數數量不正確".to_string());
    }

    let progress = std::fs::read(root.join(".comic_progress.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<HashMap<String, Progress>>(&bytes).ok())
        .unwrap_or_default();
    let mut comics = Vec::new();
    let mut image_dirs = HashSet::new();
    let mut rar_count = 0usize;

    for entry in WalkDir::new(&root)
        .max_depth(100)
        .follow_links(false)
        .into_iter()
        .filter_entry(visible)
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                eprintln!("warning: {error}");
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        let dotted = format!(".{extension}");
        if IMAGE_EXTENSIONS.contains(&dotted.as_str()) {
            if let Some(parent) = path.parent() {
                image_dirs.insert(parent.to_path_buf());
            }
        } else if matches!(extension.as_str(), "zip" | "cbz") {
            comics.push(item_for_path(&root, path, "archive", &dotted, &progress)?);
        } else if matches!(extension.as_str(), "rar" | "cbr") {
            rar_count += 1;
            comics.push(item_for_path(
                &root,
                path,
                "rar-indexed",
                &dotted,
                &progress,
            )?);
        }
    }

    for directory in image_dirs {
        if directory != root {
            comics.push(item_for_path(&root, &directory, "folder", "", &progress)?);
        }
    }
    comics.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    println!(
        "discovered={} rar_index_only={} database={}",
        comics.len(),
        rar_count,
        database.display()
    );
    let imported = CatalogStore::new(database)?.sync_library(&comics)?;
    println!("imported={imported}");
    Ok(())
}
