use crate::catalog::{CatalogStore, ComicLocationView, FileOperationRecord};
use crate::state::SmbConfig;
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

async fn catalog_call<T: Send + 'static>(
    store: &CatalogStore,
    operation: impl FnOnce(CatalogStore) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let store = store.clone();
    tokio::task::spawn_blocking(move || operation(store))
        .await
        .map_err(|error| format!("漫畫目錄背景工作失敗：{error}"))?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMutationRequest {
    pub comic_id: String,
    pub action: String,
    pub destination_relative_path: Option<String>,
    pub expected_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMutationResult {
    pub comic_id: String,
    pub action: String,
    pub relative_path: String,
    pub undo_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCapability {
    pub source_kind: String,
    pub online: bool,
    pub can_reveal: bool,
    pub can_rename: bool,
    pub can_move: bool,
    pub can_trash: bool,
    pub reason: Option<String>,
}

pub fn capability(location: &ComicLocationView, has_smb_config: bool) -> FileCapability {
    if !location.online {
        return FileCapability {
            source_kind: location.source_id.clone(),
            online: false,
            can_reveal: false,
            can_rename: false,
            can_move: false,
            can_trash: false,
            reason: Some("漫畫來源目前離線".into()),
        };
    }
    if location.source_id.starts_with("local:") && location.actual_path.is_some() {
        return FileCapability {
            source_kind: "local".into(),
            online: true,
            can_reveal: cfg!(any(target_os = "macos", target_os = "windows")),
            can_rename: true,
            can_move: true,
            can_trash: true,
            reason: None,
        };
    }
    if location.source_id == "smb" && has_smb_config {
        return FileCapability {
            source_kind: "smb".into(),
            online: true,
            can_reveal: false,
            can_rename: true,
            can_move: true,
            can_trash: true,
            reason: Some("NAS 刪除會先移到同一共用資料夾的 .gai-quarantine，可撤銷".into()),
        };
    }
    FileCapability {
        source_kind: location.source_id.clone(),
        online: true,
        can_reveal: false,
        can_rename: false,
        can_move: false,
        can_trash: false,
        reason: Some("此 Files／外部來源尚未提供可靠的可復原檔案操作".into()),
    }
}

pub async fn mutate(
    store: &CatalogStore,
    smb_config: Option<SmbConfig>,
    request: FileMutationRequest,
) -> Result<FileMutationResult, String> {
    if !matches!(request.action.as_str(), "rename" | "move" | "trash") {
        return Err("未知的檔案操作".into());
    }
    let comic_id = request.comic_id.clone();
    let location = catalog_call(store, move |store| store.get_location(&comic_id)).await?;
    if !location.online {
        return Err("漫畫來源目前離線".into());
    }
    if let (Some(expected), Some(current)) = (
        request.expected_fingerprint.as_deref(),
        location.fingerprint.as_deref(),
    ) {
        if expected != current {
            return Err("漫畫內容已變更，請重新整理後再操作".into());
        }
    }
    if location.source_id == "smb" {
        return mutate_smb(
            store,
            location,
            smb_config.ok_or("尚未設定 NAS 連線")?,
            request,
        )
        .await;
    }
    if !location.source_id.starts_with("local:") {
        return Err("此來源尚未提供安全的檔案修改".into());
    }
    catalog_call(store, move |store| mutate_local(&store, location, request)).await
}

pub async fn undo(
    store: &CatalogStore,
    smb_config: Option<SmbConfig>,
    token: &str,
) -> Result<FileMutationResult, String> {
    let token = token.to_string();
    let record = catalog_call(store, move |store| store.file_operation_for_undo(&token)).await?;
    if record.status != "succeeded" {
        return Err("此檔案操作已撤銷或目前不可撤銷".into());
    }
    if record.source_id == "smb" {
        undo_smb(store, &record, smb_config.ok_or("尚未設定 NAS 連線")?).await?;
    } else {
        let local_record = record.clone();
        catalog_call(store, move |store| undo_local(&store, &local_record)).await?;
    }
    Ok(FileMutationResult {
        comic_id: record.comic_id,
        action: "undo".into(),
        relative_path: record.before_relative_path,
        undo_token: String::new(),
    })
}

fn clean_relative(input: &str) -> Result<PathBuf, String> {
    let value = Path::new(input.trim());
    if value.as_os_str().is_empty()
        || value.is_absolute()
        || value
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("目的地必須是書庫內不含 .. 的相對路徑".into());
    }
    if value
        .components()
        .next()
        .is_some_and(|part| part.as_os_str() == ".gai-quarantine")
    {
        return Err("目的地不可使用 App 隔離區".into());
    }
    Ok(value.to_path_buf())
}

fn local_root(location: &ComicLocationView) -> Result<PathBuf, String> {
    let encoded = location
        .source_id
        .strip_prefix("local:")
        .ok_or("來源不是本機書庫")?;
    let bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "本機書庫識別已損壞")?;
    let root = PathBuf::from(String::from_utf8(bytes).map_err(|_| "本機書庫路徑編碼無效")?);
    root.canonicalize()
        .map_err(|error| format!("漫畫書庫目前無法存取：{error}"))
}

fn destination_for(
    location: &ComicLocationView,
    request: &FileMutationRequest,
    operation_id: &str,
) -> Result<PathBuf, String> {
    if request.action == "trash" {
        let name = Path::new(&location.relative_path)
            .file_name()
            .ok_or("漫畫檔名無效")?;
        return Ok(PathBuf::from(".gai-quarantine")
            .join("comics")
            .join(operation_id)
            .join(name));
    }
    let destination = request
        .destination_relative_path
        .as_deref()
        .ok_or("缺少目的地")?;
    let mut clean = clean_relative(destination)?;
    if request.action == "rename" && clean.components().count() == 1 {
        clean = Path::new(&location.relative_path)
            .parent()
            .unwrap_or(Path::new(""))
            .join(clean);
    }
    Ok(clean)
}

fn mutate_local(
    store: &CatalogStore,
    location: ComicLocationView,
    request: FileMutationRequest,
) -> Result<FileMutationResult, String> {
    let root = local_root(&location)?;
    let source = PathBuf::from(location.actual_path.as_deref().ok_or("漫畫沒有本機位置")?)
        .canonicalize()
        .map_err(|error| format!("漫畫位置無效：{error}"))?;
    if !source.starts_with(&root) {
        return Err("漫畫位置超出已授權書庫".into());
    }
    if let Some(expected) = location.fingerprint.as_deref() {
        let current = crate::catalog::sampled_fingerprint(&source)?;
        if current != expected {
            return Err("漫畫內容已在掃描後變更，請重新整理再操作".into());
        }
    }
    let provisional_id = uuid::Uuid::new_v4().to_string();
    let after_relative = destination_for(&location, &request, &provisional_id)?;
    let destination = root.join(&after_relative);
    if destination.exists() {
        return Err("目的地已有同名檔案或資料夾".into());
    }
    let parent = destination.parent().ok_or("目的地沒有父資料夾")?;
    if request.action == "trash" {
        std::fs::create_dir_all(parent).map_err(|error| format!("無法建立隔離區：{error}"))?;
    }
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("目的資料夾無法存取：{error}"))?;
    if !canonical_parent.starts_with(&root) {
        return Err("目的地超出已授權書庫".into());
    }
    let after_text = after_relative.to_string_lossy().replace('\\', "/");
    let destination_text = destination.to_string_lossy().to_string();
    let operation = store.begin_file_operation(
        &location,
        &request.action,
        Some(&after_text),
        Some(&destination_text),
    )?;
    if request.action == "trash" && !after_text.contains(&operation.id) {
        // The journal id is authoritative; replace the provisional quarantine directory before touching the source.
        let corrected = PathBuf::from(".gai-quarantine")
            .join("comics")
            .join(&operation.id)
            .join(source.file_name().ok_or("漫畫檔名無效")?);
        let corrected_abs = root.join(&corrected);
        std::fs::create_dir_all(corrected_abs.parent().ok_or("隔離區無效")?)
            .map_err(|error| error.to_string())?;
        return execute_local_move(store, location, operation, source, corrected, corrected_abs);
    }
    execute_local_move(
        store,
        location,
        operation,
        source,
        after_relative,
        destination,
    )
}

fn execute_local_move(
    store: &CatalogStore,
    location: ComicLocationView,
    operation: FileOperationRecord,
    source: PathBuf,
    after_relative: PathBuf,
    destination: PathBuf,
) -> Result<FileMutationResult, String> {
    let after_text = after_relative.to_string_lossy().replace('\\', "/");
    let destination_text = destination.to_string_lossy().to_string();
    store.set_file_operation_destination(&operation.id, &after_text, Some(&destination_text))?;
    if let Err(error) = std::fs::rename(&source, &destination) {
        let message = format!("檔案移動失敗：{error}");
        let _ = store.fail_file_operation(&operation.id, &message);
        return Err(message);
    }
    let runtime_id = general_purpose::URL_SAFE_NO_PAD.encode(after_text.as_bytes());
    if let Err(error) = store.complete_file_operation(
        &operation.id,
        Some(&runtime_id),
        operation.action != "trash",
    ) {
        let _ = std::fs::rename(&destination, &source);
        let _ = store.fail_file_operation(&operation.id, &error);
        return Err(format!("檔案已還原，但目錄更新失敗：{error}"));
    }
    Ok(FileMutationResult {
        comic_id: location.comic_id,
        action: operation.action,
        relative_path: after_text,
        undo_token: operation.undo_token,
    })
}

fn undo_local(store: &CatalogStore, record: &FileOperationRecord) -> Result<(), String> {
    let source = PathBuf::from(
        record
            .after_actual_path
            .as_deref()
            .ok_or("操作沒有可還原位置")?,
    );
    let destination = PathBuf::from(
        record
            .before_actual_path
            .as_deref()
            .ok_or("操作沒有原始位置")?,
    );
    if !source.exists() {
        return Err("隔離／移動後的檔案已不存在".into());
    }
    if destination.exists() {
        return Err("原位置已有其他檔案，為避免覆寫已停止還原".into());
    }
    std::fs::rename(&source, &destination).map_err(|error| format!("檔案還原失敗：{error}"))?;
    let runtime_id =
        general_purpose::URL_SAFE_NO_PAD.encode(record.before_relative_path.as_bytes());
    if let Err(error) = store.complete_file_operation_undo(&record.id, Some(&runtime_id)) {
        let _ = std::fs::rename(&destination, &source);
        return Err(format!("檔案已退回隔離區，但目錄還原失敗：{error}"));
    }
    Ok(())
}

async fn smb_connection(config: &SmbConfig) -> Result<(smb2::SmbClient, smb2::Tree), String> {
    let mut client = smb2::connect(
        &format!("{}:445", config.host),
        config.username.as_deref().unwrap_or("guest"),
        config.password.as_deref().unwrap_or(""),
    )
    .await
    .map_err(|error| format!("SMB 連線失敗：{error}"))?;
    let tree = client
        .connect_share(&config.share)
        .await
        .map_err(|error| format!("SMB 共用資料夾連線失敗：{error}"))?;
    Ok((client, tree))
}

async fn ensure_smb_directory(
    client: &mut smb2::SmbClient,
    tree: &mut smb2::Tree,
    path: &str,
) -> Result<(), String> {
    if client.stat(tree, path).await.is_ok() {
        return Ok(());
    }
    client
        .create_directory(tree, path)
        .await
        .map_err(|error| format!("無法建立 NAS 隔離區：{error}"))
}

async fn mutate_smb(
    store: &CatalogStore,
    location: ComicLocationView,
    config: SmbConfig,
    request: FileMutationRequest,
) -> Result<FileMutationResult, String> {
    let provisional_id = uuid::Uuid::new_v4().to_string();
    let mut after = destination_for(&location, &request, &provisional_id)?
        .to_string_lossy()
        .replace('/', "\\");
    let before = location.relative_path.replace('/', "\\");
    let journal_location = location.clone();
    let journal_action = request.action.clone();
    let journal_after = after.replace('\\', "/");
    let operation = catalog_call(store, move |store| {
        store.begin_file_operation(
            &journal_location,
            &journal_action,
            Some(&journal_after),
            None,
        )
    })
    .await?;
    if request.action == "trash" {
        after = format!(
            ".gai-quarantine\\{}\\{}",
            operation.id,
            Path::new(&location.relative_path)
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or("漫畫檔名無效")?
        );
    }
    let after_relative = after.replace('\\', "/");
    let operation_id = operation.id.clone();
    let journal_after = after_relative.clone();
    catalog_call(store, move |store| {
        store.set_file_operation_destination(&operation_id, &journal_after, None)
    })
    .await?;
    let (mut client, mut tree) = smb_connection(&config).await?;
    client
        .stat(&mut tree, &before)
        .await
        .map_err(|error| format!("NAS 漫畫不存在或無權限：{error}"))?;
    if request.action == "trash" {
        ensure_smb_directory(&mut client, &mut tree, ".gai-quarantine").await?;
        ensure_smb_directory(
            &mut client,
            &mut tree,
            &format!(".gai-quarantine\\{}", operation.id),
        )
        .await?;
    }
    if client.stat(&mut tree, &after).await.is_ok() {
        return Err("NAS 目的地已有同名項目".into());
    }
    if let Err(error) = client.rename(&mut tree, &before, &after).await {
        let message = format!("NAS 檔案移動失敗：{error}");
        let operation_id = operation.id.clone();
        let failure = message.clone();
        let _ = catalog_call(store, move |store| {
            store.fail_file_operation(&operation_id, &failure)
        })
        .await;
        return Err(message);
    }
    let runtime_id = general_purpose::URL_SAFE_NO_PAD.encode(after_relative.as_bytes());
    let operation_id = operation.id.clone();
    let online = operation.action != "trash";
    let completed = catalog_call(store, move |store| {
        store.complete_file_operation(&operation_id, Some(&runtime_id), online)
    })
    .await;
    if let Err(error) = completed {
        let _ = client.rename(&mut tree, &after, &before).await;
        let operation_id = operation.id.clone();
        let failure = error.clone();
        let _ = catalog_call(store, move |store| {
            store.fail_file_operation(&operation_id, &failure)
        })
        .await;
        return Err(format!("NAS 檔案已還原，但目錄更新失敗：{error}"));
    }
    Ok(FileMutationResult {
        comic_id: location.comic_id,
        action: operation.action,
        relative_path: after_relative,
        undo_token: operation.undo_token,
    })
}

async fn undo_smb(
    store: &CatalogStore,
    record: &FileOperationRecord,
    config: SmbConfig,
) -> Result<(), String> {
    let after = record
        .after_relative_path
        .as_deref()
        .ok_or("操作沒有 NAS 目的地")?
        .replace('/', "\\");
    let before = record.before_relative_path.replace('/', "\\");
    let (mut client, mut tree) = smb_connection(&config).await?;
    if client.stat(&mut tree, &before).await.is_ok() {
        return Err("NAS 原位置已有其他項目，已停止還原".into());
    }
    client
        .rename(&mut tree, &after, &before)
        .await
        .map_err(|error| format!("NAS 還原失敗：{error}"))?;
    let runtime_id =
        general_purpose::URL_SAFE_NO_PAD.encode(record.before_relative_path.as_bytes());
    let operation_id = record.id.clone();
    let completed = catalog_call(store, move |store| {
        store.complete_file_operation_undo(&operation_id, Some(&runtime_id))
    })
    .await;
    if let Err(error) = completed {
        let _ = client.rename(&mut tree, &before, &after).await;
        return Err(format!("NAS 檔案已退回隔離區，但目錄還原失敗：{error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{ComicItem, Progress};

    #[test]
    fn relative_destination_rejects_escape_and_reserved_quarantine() {
        assert!(clean_relative("../outside.cbz").is_err());
        assert!(clean_relative("/outside.cbz").is_err());
        assert!(clean_relative(".gai-quarantine/stolen.cbz").is_err());
        assert_eq!(
            clean_relative("系列/作品.cbz").unwrap(),
            PathBuf::from("系列/作品.cbz")
        );
    }

    #[test]
    fn local_rename_and_undo_keep_stable_identity_and_progress() {
        let base = std::env::temp_dir().join(format!("gai-file-op-{}", uuid::Uuid::new_v4()));
        let root = base.join("library");
        let original = root.join("book");
        std::fs::create_dir_all(&original).unwrap();
        std::fs::write(original.join("001.jpg"), b"synthetic-page").unwrap();
        let runtime_id = general_purpose::URL_SAFE_NO_PAD.encode(b"book");
        let store = CatalogStore::new(base.join("catalog.sqlite3")).unwrap();
        store
            .sync_library(&[ComicItem {
                id: runtime_id.clone(),
                r#type: "folder".into(),
                relative_path: "book".into(),
                ext: String::new(),
                title: "book".into(),
                series: "test".into(),
                updated_at: "2026-08-30T00:00:00Z".into(),
                page_count: 1,
                progress: Progress {
                    current_page: 3,
                    total_pages: 10,
                    percent: 30.0,
                    updated_at: Some("2026-08-30T00:00:00Z".into()),
                },
                source_id: crate::scanner::local_source_id(&root),
                source_path: Some(original.to_string_lossy().into_owned()),
                external_bookmark: None,
            }])
            .unwrap();
        let location = store.get_location(&runtime_id).unwrap();
        let stable_id = location.comic_id.clone();
        let result = mutate_local(
            &store,
            location,
            FileMutationRequest {
                comic_id: runtime_id,
                action: "rename".into(),
                destination_relative_path: Some("renamed".into()),
                expected_fingerprint: None,
            },
        )
        .unwrap();
        assert!(!original.exists());
        assert!(root.join("renamed").exists());
        let renamed = store.get_runtime_item(&stable_id).unwrap().unwrap();
        assert_eq!(renamed.relative_path, "renamed");
        assert_eq!(renamed.progress.current_page, 3);
        let operation = store.file_operation_for_undo(&result.undo_token).unwrap();
        undo_local(&store, &operation).unwrap();
        assert!(original.exists());
        assert!(!root.join("renamed").exists());
        let restored = store.get_runtime_item(&stable_id).unwrap().unwrap();
        assert_eq!(restored.relative_path, "book");
        assert_eq!(restored.progress.current_page, 3);

        // Simulate a crash after the filesystem rename but before the SQLite commit.
        let location = store.get_location(&stable_id).unwrap();
        let crash_destination = root.join("recovered");
        let crash_operation = store
            .begin_file_operation(
                &location,
                "rename",
                Some("recovered"),
                Some(&crash_destination.to_string_lossy()),
            )
            .unwrap();
        std::fs::rename(&original, &crash_destination).unwrap();
        let reconciled = store.reconcile_file_operations().unwrap();
        assert_eq!(reconciled.completed, 1);
        assert_eq!(
            store
                .get_runtime_item(&stable_id)
                .unwrap()
                .unwrap()
                .relative_path,
            "recovered"
        );
        undo_local(
            &store,
            &store
                .file_operation_for_undo(&crash_operation.undo_token)
                .unwrap(),
        )
        .unwrap();
        drop(store);
        let _ = std::fs::remove_dir_all(&base);
    }
}
