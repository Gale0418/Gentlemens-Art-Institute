#[cfg(test)]
use crate::catalog::CatalogQuery;
use crate::catalog::{CatalogStore, ComicLocationView, FileOperationRecord};
use crate::state::SmbConfig;
use base64::{engine::general_purpose, Engine as _};
use cap_fs_ext::DirExt;
#[cfg(windows)]
use cap_fs_ext::{OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
#[cfg(windows)]
use cap_std::fs::OpenOptionsExt;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
#[cfg(windows)]
use std::{
    mem::{align_of, size_of},
    os::windows::{ffi::OsStrExt, io::AsRawHandle},
};
#[cfg(windows)]
use windows_sys::Win32::Foundation::{GetLastError, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    FileRenameInfo, SetFileInformationByHandle, DELETE, FILE_RENAME_INFO, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE,
};

const SMB_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SMB_IO_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(test)]
static UNDO_TEST_FORCE_ROLLBACK_COLLISION: AtomicBool = AtomicBool::new(false);

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "linux"))]
fn rename_noreplace(
    from_dir: &cap_std::fs::Dir,
    from: &Path,
    to_dir: &cap_std::fs::Dir,
    to: &Path,
) -> std::io::Result<()> {
    rustix::fs::renameat_with(
        from_dir,
        from,
        to_dir,
        to,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(Into::into)
}

#[cfg(windows)]
fn rename_noreplace(
    from_dir: &cap_std::fs::Dir,
    from: &Path,
    to_dir: &cap_std::fs::Dir,
    to: &Path,
) -> std::io::Result<()> {
    let is_basename = |path: &Path| {
        path.components().count() == 1
            && matches!(path.components().next(), Some(Component::Normal(_)))
    };
    if !is_basename(from) || !is_basename(to) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Windows no-clobber rename 只接受單一 source/destination 名稱",
        ));
    }
    let mut options = cap_std::fs::OpenOptions::new();
    options
        .read(true)
        .maybe_dir(true)
        .follow(cap_fs_ext::FollowSymlinks::No)
        .access_mode(DELETE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    let source_file = from_dir.open_with(from, &options)?;
    let name = to.as_os_str().encode_wide().collect::<Vec<_>>();
    if align_of::<FILE_RENAME_INFO>() > align_of::<usize>() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Windows no-clobber rename 的 buffer alignment 不受支援",
        ));
    }
    let file_name_offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    let name_size = name
        .len()
        .checked_mul(size_of::<u16>())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "目的地名稱過長"))?;
    let buffer_size = file_name_offset
        .checked_add(name_size)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "目的地名稱過長"))?;
    let buffer_size_u32 = u32::try_from(buffer_size)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "目的地名稱過長"))?;
    let name_size_u32 = u32::try_from(name_size)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "目的地名稱過長"))?;
    let words = buffer_size
        .checked_add(size_of::<usize>() - 1)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "目的地名稱過長"))?
        / size_of::<usize>();
    let mut buffer = vec![0usize; words];
    unsafe {
        let buffer_ptr = buffer.as_mut_ptr().cast::<u8>();
        let info = buffer_ptr.cast::<FILE_RENAME_INFO>();
        (*info).Anonymous.ReplaceIfExists = 0;
        (*info).RootDirectory = to_dir.as_raw_handle() as HANDLE;
        (*info).FileNameLength = name_size_u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            buffer_ptr.add(file_name_offset).cast(),
            name.len(),
        );
        if SetFileInformationByHandle(
            source_file.as_raw_handle() as HANDLE,
            FileRenameInfo,
            buffer_ptr.cast(),
            buffer_size_u32,
        ) == 0
        {
            return Err(std::io::Error::from_raw_os_error(GetLastError() as i32));
        }
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "linux", windows)))]
fn rename_noreplace(
    _from_dir: &cap_std::fs::Dir,
    _from: &Path,
    _to_dir: &cap_std::fs::Dir,
    _to: &Path,
) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "此平台沒有可用的原子 no-clobber rename",
    ))
}

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
    pub expected_fingerprint: Option<String>,
    pub can_reveal: bool,
    pub can_rename: bool,
    pub can_move: bool,
    pub can_trash: bool,
    pub reason: Option<String>,
}

pub fn capability(location: &ComicLocationView, has_smb_config: bool) -> FileCapability {
    let expected_fingerprint = (!location.fingerprint_collision)
        .then(|| {
            location.fingerprint.clone().or_else(|| {
                crate::catalog::location_revision(
                    &location.source_id,
                    &location.relative_path,
                    location.size,
                    location.mtime.as_deref(),
                )
            })
        })
        .flatten();
    if !location.online {
        return FileCapability {
            source_kind: location.source_id.clone(),
            online: false,
            expected_fingerprint: None,
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
            expected_fingerprint: expected_fingerprint.clone(),
            can_reveal: expected_fingerprint.is_some()
                && cfg!(any(target_os = "macos", target_os = "windows")),
            can_rename: expected_fingerprint.is_some(),
            can_move: expected_fingerprint.is_some(),
            can_trash: expected_fingerprint.is_some(),
            reason: expected_fingerprint
                .is_none()
                .then_some("缺少可驗證的檔案版本，已停用檔案操作".into()),
        };
    }
    if location.source_id == "smb" && has_smb_config {
        return FileCapability {
            source_kind: "smb".into(),
            online: true,
            expected_fingerprint: expected_fingerprint.clone(),
            can_reveal: false,
            can_rename: expected_fingerprint.is_some(),
            can_move: expected_fingerprint.is_some(),
            can_trash: expected_fingerprint.is_some(),
            reason: Some(
                "NAS 操作會先驗證位置版本；刪除會移到同一共用資料夾的 .gai-quarantine，可撤銷"
                    .into(),
            ),
        };
    }
    FileCapability {
        source_kind: location.source_id.clone(),
        online: true,
        expected_fingerprint: None,
        can_reveal: false,
        can_rename: false,
        can_move: false,
        can_trash: false,
        reason: Some("此 Files／外部來源尚未提供可靠的可復原檔案操作".into()),
    }
}

pub async fn capability_with_smb_config(
    location: &ComicLocationView,
    smb_config: Option<SmbConfig>,
) -> FileCapability {
    let mut result = capability(location, smb_config.is_some());
    if location.source_id != "smb" || !location.online {
        return result;
    }
    let Some(config) = smb_config else {
        return result;
    };
    let Ok(before) = smb_wire_path(&location.relative_path, false) else {
        disable_smb_capability(&mut result, "NAS 漫畫路徑不安全，已停用檔案操作");
        return result;
    };
    let Ok((mut client, mut tree)) = smb_connection(&config).await else {
        disable_smb_capability(&mut result, "NAS 目前無法驗證漫畫位置版本，已停用檔案操作");
        return result;
    };
    let Ok(info) = smb_stat_required(&mut client, &mut tree, &before).await else {
        disable_smb_capability(
            &mut result,
            "NAS 漫畫不存在或無法取得位置版本，已停用檔案操作",
        );
        return result;
    };
    result.expected_fingerprint = Some(smb_location_revision(
        &location.source_id,
        &location.relative_path,
        info.size,
        info.modified.0,
    ));
    result.can_rename = true;
    result.can_move = true;
    result.can_trash = true;
    result.reason =
        Some("NAS 操作會先驗證位置版本；刪除會移到同一共用資料夾的 .gai-quarantine，可撤銷".into());
    result
}

fn disable_smb_capability(capability: &mut FileCapability, reason: &str) {
    capability.expected_fingerprint = None;
    capability.can_rename = false;
    capability.can_move = false;
    capability.can_trash = false;
    capability.reason = Some(reason.into());
}

fn smb_location_revision(source_id: &str, relative_path: &str, size: u64, mtime: u64) -> String {
    format!(
        "smb-location-revision-v1:{}",
        serde_json::json!({
            "source": source_id,
            "path": relative_path,
            "size": size,
            "mtime": mtime,
        })
    )
}

fn smb_runtime_id(relative_path: &str) -> String {
    general_purpose::URL_SAFE_NO_PAD.encode(format!("./{relative_path}").as_bytes())
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
    let expected = request
        .expected_fingerprint
        .as_deref()
        .ok_or("缺少檔案版本前置條件，請重新整理後再操作")?;
    if location.source_id != "smb" {
        let registered =
            registered_fingerprint(&location).ok_or("缺少可驗證的檔案版本，已停止操作")?;
        if expected != registered {
            return Err("漫畫位置已變更，請重新整理後再操作".into());
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

fn registered_fingerprint(location: &ComicLocationView) -> Option<String> {
    if location.fingerprint_collision {
        return None;
    }
    location.fingerprint.clone().or_else(|| {
        crate::catalog::location_revision(
            &location.source_id,
            &location.relative_path,
            location.size,
            location.mtime.as_deref(),
        )
    })
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
    let trimmed = input.trim();
    if trimmed.contains('\\') || trimmed.chars().any(char::is_control) {
        return Err("目的地只能使用 / 作為路徑分隔符，且不可包含控制字元".into());
    }
    let value = Path::new(trimmed);
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

fn smb_wire_path(input: &str, allow_quarantine: bool) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.contains('\\') || trimmed.chars().any(char::is_control) {
        return Err("NAS 路徑格式不安全".into());
    }
    let path = Path::new(trimmed);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("NAS 路徑必須是共用資料夾內的安全相對路徑".into());
    }
    if !allow_quarantine
        && path
            .components()
            .next()
            .is_some_and(|part| part.as_os_str() == ".gai-quarantine")
    {
        return Err("一般 NAS 操作不可直接使用 App 隔離區".into());
    }
    Ok(trimmed.replace('/', "\\"))
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

fn open_local_root(root: &Path) -> Result<cap_std::fs::Dir, String> {
    let parent = root.parent().ok_or("漫畫書庫沒有可用父資料夾")?;
    let name = root.file_name().ok_or("漫畫書庫名稱無效")?;
    let parent_dir = cap_std::fs::Dir::open_ambient_dir(parent, cap_std::ambient_authority())
        .map_err(|error| format!("漫畫書庫父資料夾目前無法安全開啟：{error}"))?;
    parent_dir
        .open_dir_nofollow(name)
        .map_err(|error| format!("漫畫書庫根目錄不是安全資料夾：{error}"))
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

fn validate_local_relative(path: &Path, allow_empty: bool) -> Result<(), String> {
    if !allow_empty && path.as_os_str().is_empty() {
        return Err("檔案路徑不可為空".into());
    }
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("檔案路徑必須是書庫內安全的相對路徑".into());
    }
    Ok(())
}

fn open_local_dir(
    root: &cap_std::fs::Dir,
    relative: &Path,
    create_missing: bool,
) -> Result<cap_std::fs::Dir, String> {
    validate_local_relative(relative, true)?;
    let mut current = root
        .try_clone()
        .map_err(|error| format!("無法複製書庫目錄描述元：{error}"))?;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("書庫目錄包含不安全元件".into());
        };
        let next = match current.open_dir_nofollow(name) {
            Ok(directory) => directory,
            Err(error) if create_missing && error.kind() == std::io::ErrorKind::NotFound => {
                current
                    .create_dir(name)
                    .map_err(|error| format!("無法建立書庫目的資料夾：{error}"))?;
                current
                    .open_dir_nofollow(name)
                    .map_err(|error| format!("書庫目的資料夾無法安全開啟：{error}"))?
            }
            Err(error) => {
                return Err(format!("書庫目錄無法安全開啟：{error}"));
            }
        };
        current = next;
    }
    Ok(current)
}

fn open_local_parent(
    root: &cap_std::fs::Dir,
    relative: &Path,
    create_missing: bool,
) -> Result<(cap_std::fs::Dir, PathBuf), String> {
    validate_local_relative(relative, false)?;
    let name = relative
        .file_name()
        .ok_or("檔案路徑缺少檔名")
        .map(PathBuf::from)?;
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    Ok((open_local_dir(root, parent, create_missing)?, name))
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
    let source_relative = source
        .strip_prefix(&root)
        .map_err(|_| "漫畫位置無法轉為書庫相對路徑")?
        .to_path_buf();
    validate_local_relative(&source_relative, false)?;
    let root_dir = open_local_root(&root)?;
    let (source_dir, source_name) = open_local_parent(&root_dir, &source_relative, false)?;
    let source_metadata = source_dir
        .symlink_metadata(&source_name)
        .map_err(|error| format!("漫畫位置無效：{error}"))?;
    if source_metadata.file_type().is_symlink() {
        return Err("漫畫位置不可使用符號連結".into());
    }
    if location.fingerprint_collision {
        return Err("漫畫檔案版本與其他項目碰撞，已停止操作".into());
    }
    let expected = request
        .expected_fingerprint
        .as_deref()
        .ok_or("缺少檔案版本前置條件，請重新整理後再操作")?;
    let current = if location.fingerprint.is_some() {
        crate::catalog::sampled_fingerprint_from_dir(&source_dir, &source_name)?
    } else {
        let (size, mtime) = crate::catalog::file_signature_from_dir(&source_dir, &source_name)
            .ok_or("無法取得漫畫檔案版本，已停止操作")?;
        crate::catalog::location_revision(
            &location.source_id,
            &location.relative_path,
            size,
            mtime.as_deref(),
        )
        .ok_or("無法取得漫畫檔案版本，已停止操作")?
    };
    if current != expected {
        return Err("漫畫位置已在掃描後變更，請重新整理再操作".into());
    }
    let provisional_id = uuid::Uuid::new_v4().to_string();
    let after_relative = destination_for(&location, &request, &provisional_id)?;
    let after_text = after_relative.to_string_lossy().replace('\\', "/");
    let destination_text = root.join(&after_relative).to_string_lossy().to_string();
    let operation = store.begin_file_operation(
        &location,
        &request.action,
        Some(&after_text),
        Some(&destination_text),
    )?;
    if let Err(error) = store.set_file_operation_expected_fingerprint(&operation.id, expected) {
        let _ = store.fail_file_operation(&operation.id, &error);
        return Err(error);
    }
    let after_relative = if request.action == "trash" {
        PathBuf::from(".gai-quarantine")
            .join("comics")
            .join(&operation.id)
            .join(&source_name)
    } else {
        after_relative
    };
    execute_local_move(
        store,
        location,
        operation,
        root,
        root_dir,
        source_dir,
        source_name,
        after_relative,
    )
}

#[allow(clippy::too_many_arguments)]
fn execute_local_move(
    store: &CatalogStore,
    location: ComicLocationView,
    operation: FileOperationRecord,
    root_path: PathBuf,
    root: cap_std::fs::Dir,
    source_dir: cap_std::fs::Dir,
    source_name: PathBuf,
    after_relative: PathBuf,
) -> Result<FileMutationResult, String> {
    let source_metadata = match source_dir.symlink_metadata(&source_name) {
        Ok(metadata) => metadata,
        Err(error) => {
            let message = format!("漫畫位置無效：{error}");
            let _ = store.fail_file_operation(&operation.id, &message);
            return Err(message);
        }
    };
    if source_metadata.file_type().is_symlink() {
        let message = "漫畫位置不可使用符號連結".to_string();
        let _ = store.fail_file_operation(&operation.id, &message);
        return Err(message);
    }
    let create_destination_parent = operation.action == "trash";
    let (destination_dir, destination_name) =
        match open_local_parent(&root, &after_relative, create_destination_parent) {
            Ok(value) => value,
            Err(error) => {
                let _ = store.fail_file_operation(&operation.id, &error);
                return Err(error);
            }
        };
    let destination_exists = match destination_dir.try_exists(&destination_name) {
        Ok(exists) => exists,
        Err(error) => {
            let message = format!("無法檢查目的地：{error}");
            let _ = store.fail_file_operation(&operation.id, &message);
            if operation.action == "trash" {
                let _ = destination_dir.remove_open_dir();
            }
            return Err(message);
        }
    };
    if destination_exists {
        let message = "目的地已有同名檔案或資料夾".to_string();
        let _ = store.fail_file_operation(&operation.id, &message);
        if operation.action == "trash" {
            let _ = destination_dir.remove_open_dir();
        }
        return Err(message);
    }
    let after_text = after_relative.to_string_lossy().replace('\\', "/");
    let destination_text = root_path
        .join(&after_relative)
        .to_string_lossy()
        .to_string();
    if let Err(error) =
        store.set_file_operation_destination(&operation.id, &after_text, Some(&destination_text))
    {
        let _ = store.fail_file_operation(&operation.id, &error);
        if operation.action == "trash" {
            let _ = destination_dir.remove_open_dir();
        }
        return Err(error);
    }
    if let Err(error) = rename_noreplace(
        &source_dir,
        &source_name,
        &destination_dir,
        &destination_name,
    ) {
        let message = format!("檔案移動失敗：{error}");
        let _ = store.fail_file_operation(&operation.id, &message);
        if operation.action == "trash" {
            let _ = destination_dir.remove_open_dir();
        }
        return Err(message);
    }
    let runtime_id = general_purpose::URL_SAFE_NO_PAD.encode(after_text.as_bytes());
    if let Err(error) = store.complete_file_operation(
        &operation.id,
        Some(&runtime_id),
        operation.action != "trash",
    ) {
        let rollback = rename_noreplace(
            &destination_dir,
            &destination_name,
            &source_dir,
            &source_name,
        );
        let failure = match rollback {
            Ok(()) => {
                if operation.action == "trash" {
                    let _ = destination_dir.remove_open_dir();
                }
                format!("目錄更新失敗，檔案已還原：{error}")
            }
            Err(rollback_error) => {
                let failure = format!(
                    "目錄更新失敗，且檔案自動還原也失敗（需要人工檢查）：{error}; rollback: {rollback_error}"
                );
                let _ = store.mark_file_operation_needs_reconcile(&operation.id, &failure);
                failure
            }
        };
        let _ = store.fail_file_operation(&operation.id, &failure);
        return Err(failure);
    }
    Ok(FileMutationResult {
        comic_id: location.comic_id,
        action: operation.action,
        relative_path: after_text,
        undo_token: operation.undo_token,
    })
}

fn undo_local(store: &CatalogStore, record: &FileOperationRecord) -> Result<(), String> {
    let root_location = ComicLocationView {
        id: record.location_id,
        comic_id: record.comic_id.clone(),
        runtime_id: None,
        source_id: record.source_id.clone(),
        relative_path: record.before_relative_path.clone(),
        actual_path: record.before_actual_path.clone(),
        kind: String::new(),
        size: None,
        mtime: None,
        fingerprint: None,
        fingerprint_collision: false,
        online: true,
    };
    let root = local_root(&root_location)?;
    let source_relative = PathBuf::from(
        record
            .after_relative_path
            .as_deref()
            .ok_or("操作沒有可還原位置")?,
    );
    let destination_relative = PathBuf::from(&record.before_relative_path);
    validate_local_relative(&source_relative, false)?;
    validate_local_relative(&destination_relative, false)?;
    let root_dir = open_local_root(&root)?;
    let (source_dir, source_name) = open_local_parent(&root_dir, &source_relative, false)?;
    if source_dir
        .symlink_metadata(&source_name)
        .map_err(|error| format!("隔離／移動後的檔案位置無效：{error}"))?
        .file_type()
        .is_symlink()
    {
        return Err("還原來源不可使用符號連結".into());
    }
    let (destination_dir, destination_name) =
        open_local_parent(&root_dir, &destination_relative, false)?;
    if destination_dir
        .try_exists(&destination_name)
        .map_err(|error| format!("無法檢查原位置：{error}"))?
    {
        return Err("原位置已有其他檔案，為避免覆寫已停止還原".into());
    }
    let expected = record
        .expected_fingerprint
        .as_deref()
        .ok_or("操作缺少檔案版本前置條件，已停止還原")?;
    let current = local_undo_fingerprint(&source_dir, &source_name, record, expected)?;
    if current != expected {
        return Err("隔離／移動後的檔案版本已變更，已停止還原".into());
    }

    rename_noreplace(
        &source_dir,
        &source_name,
        &destination_dir,
        &destination_name,
    )
    .map_err(|error| format!("檔案還原失敗：{error}"))?;
    #[cfg(test)]
    if UNDO_TEST_FORCE_ROLLBACK_COLLISION.swap(false, Ordering::SeqCst) {
        source_dir
            .write(&source_name, b"rollback collision")
            .map_err(|error| format!("測試 rollback collision 建立失敗：{error}"))?;
    }
    let runtime_id =
        general_purpose::URL_SAFE_NO_PAD.encode(record.before_relative_path.as_bytes());
    if let Err(error) = store.complete_file_operation_undo(&record.id, Some(&runtime_id)) {
        let rollback = rename_noreplace(
            &destination_dir,
            &destination_name,
            &source_dir,
            &source_name,
        );
        return match rollback {
            Ok(()) => Err(format!("目錄還原失敗，檔案已退回原隔離／移動位置：{error}")),
            Err(rollback_error) => {
                let failure = format!(
                    "目錄還原失敗，且檔案退回也失敗（需要人工檢查）：{error}; rollback: {rollback_error}"
                );
                let _ = store.mark_file_operation_needs_reconcile(&record.id, &failure);
                Err(failure)
            }
        };
    }
    if record.action == "trash" {
        let _ = source_dir.remove_open_dir();
    }
    Ok(())
}

fn local_undo_fingerprint(
    source_dir: &cap_std::fs::Dir,
    source_name: &Path,
    record: &FileOperationRecord,
    expected: &str,
) -> Result<String, String> {
    if expected.starts_with("location-revision-v1:") {
        let (size, mtime) = crate::catalog::file_signature_from_dir(source_dir, source_name)
            .ok_or("無法取得檔案還原版本，已停止還原")?;
        crate::catalog::location_revision(
            &record.source_id,
            &record.before_relative_path,
            size,
            mtime.as_deref(),
        )
        .ok_or("無法取得檔案還原版本，已停止還原".into())
    } else {
        crate::catalog::sampled_fingerprint_from_dir(source_dir, source_name)
    }
}

async fn smb_connection(config: &SmbConfig) -> Result<(smb2::SmbClient, smb2::Tree), String> {
    let mut client = tokio::time::timeout(
        SMB_CONNECT_TIMEOUT,
        smb2::connect(
            &format!("{}:445", config.host),
            config.username.as_deref().unwrap_or("guest"),
            config.password.as_deref().unwrap_or(""),
        ),
    )
    .await
    .map_err(|_| "SMB 連線逾時（10 秒）".to_string())?
    .map_err(|error| format!("SMB 連線失敗：{error}"))?;
    let tree = tokio::time::timeout(SMB_CONNECT_TIMEOUT, client.connect_share(&config.share))
        .await
        .map_err(|_| "SMB 共用資料夾連線逾時（10 秒）".to_string())?
        .map_err(|error| format!("SMB 共用資料夾連線失敗：{error}"))?;
    Ok((client, tree))
}

async fn smb_stat_optional(
    client: &mut smb2::SmbClient,
    tree: &mut smb2::Tree,
    path: &str,
) -> Result<Option<smb2::FileInfo>, String> {
    let result = tokio::time::timeout(SMB_IO_TIMEOUT, client.stat(tree, path))
        .await
        .map_err(|_| format!("SMB stat 逾時（30 秒）：{path}"))?;
    match result {
        Ok(info) => Ok(Some(info)),
        Err(error) if error.kind() == smb2::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("SMB stat 失敗：{error}")),
    }
}

async fn smb_stat_required(
    client: &mut smb2::SmbClient,
    tree: &mut smb2::Tree,
    path: &str,
) -> Result<smb2::FileInfo, String> {
    smb_stat_optional(client, tree, path)
        .await?
        .ok_or_else(|| format!("SMB 路徑不存在：{path}"))
}

async fn smb_rename(
    client: &mut smb2::SmbClient,
    tree: &mut smb2::Tree,
    from: &str,
    to: &str,
) -> Result<(), String> {
    tokio::time::timeout(SMB_IO_TIMEOUT, client.rename(tree, from, to))
        .await
        .map_err(|_| "SMB 檔案移動逾時（30 秒）".to_string())?
        .map_err(|error| format!("SMB 檔案移動失敗：{error}"))
}

async fn ensure_smb_directory(
    client: &mut smb2::SmbClient,
    tree: &mut smb2::Tree,
    path: &str,
) -> Result<(), String> {
    match smb_stat_optional(client, tree, path).await? {
        Some(info) if info.is_directory => Ok(()),
        Some(_) => Err(format!("NAS 隔離區路徑已被檔案占用：{path}")),
        None => tokio::time::timeout(SMB_IO_TIMEOUT, client.create_directory(tree, path))
            .await
            .map_err(|_| format!("建立 NAS 目錄逾時（30 秒）：{path}"))?
            .map_err(|error| format!("無法建立 NAS 隔離區：{error}")),
    }
}

async fn remove_smb_directory_if_empty(
    client: &mut smb2::SmbClient,
    tree: &mut smb2::Tree,
    path: &str,
) {
    let _ = tokio::time::timeout(SMB_IO_TIMEOUT, client.delete_directory(tree, path)).await;
}

async fn fail_smb_journal(store: &CatalogStore, operation_id: &str, message: &str) {
    let operation_id = operation_id.to_string();
    let message = message.to_string();
    let _ = catalog_call(store, move |store| {
        store.fail_file_operation(&operation_id, &message)
    })
    .await;
}

async fn mutate_smb(
    store: &CatalogStore,
    location: ComicLocationView,
    config: SmbConfig,
    request: FileMutationRequest,
) -> Result<FileMutationResult, String> {
    let expected = request
        .expected_fingerprint
        .as_deref()
        .ok_or("缺少 NAS 位置版本前置條件，請重新整理後再操作")?;
    let before = smb_wire_path(&location.relative_path, false)?;
    let (mut client, mut tree) = smb_connection(&config).await?;
    let info = smb_stat_required(&mut client, &mut tree, &before)
        .await
        .map_err(|error| format!("NAS 漫畫不存在或無權限：{error}"))?;
    let current = smb_location_revision(
        &location.source_id,
        &location.relative_path,
        info.size,
        info.modified.0,
    );
    if current != expected {
        return Err("NAS 漫畫位置已變更，請重新整理後再操作".into());
    }

    let provisional_id = uuid::Uuid::new_v4().to_string();
    let initial_after_relative = if request.action == "trash" {
        let filename = Path::new(&location.relative_path)
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("漫畫檔名無效")?;
        format!(".gai-quarantine/{provisional_id}/{filename}")
    } else {
        destination_for(&location, &request, &provisional_id)?
            .to_string_lossy()
            .replace('\\', "/")
    };
    let _ = smb_wire_path(&initial_after_relative, request.action == "trash")?;

    let journal_location = location.clone();
    let journal_action = request.action.clone();
    let initial_after = initial_after_relative.clone();
    let operation = catalog_call(store, move |store| {
        store.begin_file_operation(
            &journal_location,
            &journal_action,
            Some(&initial_after),
            None,
        )
    })
    .await?;
    let expected_for_journal = expected.to_string();
    let operation_id = operation.id.clone();
    if let Err(error) = catalog_call(store, move |store| {
        store.set_file_operation_expected_fingerprint(&operation_id, &expected_for_journal)
    })
    .await
    {
        fail_smb_journal(store, &operation.id, &error).await;
        return Err(error);
    }

    let after_relative = if request.action == "trash" {
        let filename = Path::new(&location.relative_path)
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("漫畫檔名無效")?;
        format!(".gai-quarantine/{}/{filename}", operation.id)
    } else {
        initial_after_relative
    };
    let after = smb_wire_path(&after_relative, request.action == "trash")?;
    let operation_id = operation.id.clone();
    let journal_after = after_relative.clone();
    if let Err(error) = catalog_call(store, move |store| {
        store.set_file_operation_destination(&operation_id, &journal_after, None)
    })
    .await
    {
        fail_smb_journal(store, &operation.id, &error).await;
        return Err(error);
    }

    let quarantine_dir =
        (request.action == "trash").then(|| format!(".gai-quarantine\\{}", operation.id));
    if request.action == "trash" {
        if let Err(error) = ensure_smb_directory(&mut client, &mut tree, ".gai-quarantine").await {
            fail_smb_journal(store, &operation.id, &error).await;
            return Err(error);
        }
        if let Some(directory) = quarantine_dir.as_deref() {
            if let Err(error) = ensure_smb_directory(&mut client, &mut tree, directory).await {
                fail_smb_journal(store, &operation.id, &error).await;
                return Err(error);
            }
        }
    }
    match smb_stat_optional(&mut client, &mut tree, &after).await {
        Ok(Some(_)) => {
            let message = "NAS 目的地已有同名項目".to_string();
            if let Some(directory) = quarantine_dir.as_deref() {
                remove_smb_directory_if_empty(&mut client, &mut tree, directory).await;
            }
            fail_smb_journal(store, &operation.id, &message).await;
            return Err(message);
        }
        Ok(None) => {}
        Err(error) => {
            if let Some(directory) = quarantine_dir.as_deref() {
                remove_smb_directory_if_empty(&mut client, &mut tree, directory).await;
            }
            fail_smb_journal(store, &operation.id, &error).await;
            return Err(error);
        }
    }

    if let Err(error) = smb_rename(&mut client, &mut tree, &before, &after).await {
        if let Some(directory) = quarantine_dir.as_deref() {
            remove_smb_directory_if_empty(&mut client, &mut tree, directory).await;
        }
        fail_smb_journal(store, &operation.id, &error).await;
        return Err(error);
    }
    let runtime_id = smb_runtime_id(&after_relative);
    let operation_id = operation.id.clone();
    let online = operation.action != "trash";
    let completed = catalog_call(store, move |store| {
        store.complete_file_operation(&operation_id, Some(&runtime_id), online)
    })
    .await;
    if let Err(error) = completed {
        let rollback = smb_rename(&mut client, &mut tree, &after, &before).await;
        let failure = match rollback {
            Ok(()) => {
                if let Some(directory) = quarantine_dir.as_deref() {
                    remove_smb_directory_if_empty(&mut client, &mut tree, directory).await;
                }
                format!("目錄更新失敗，NAS 檔案已還原：{error}")
            }
            Err(rollback_error) => {
                let failure = format!(
                    "目錄更新失敗，且 NAS 檔案自動還原也失敗（需要人工檢查）：{error}; rollback: {rollback_error}"
                );
                let operation_id = operation.id.clone();
                let message = failure.clone();
                let _ = catalog_call(store, move |store| {
                    store.mark_file_operation_needs_reconcile(&operation_id, &message)
                })
                .await;
                failure
            }
        };
        fail_smb_journal(store, &operation.id, &failure).await;
        return Err(failure);
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
    let after_relative = record
        .after_relative_path
        .as_deref()
        .ok_or("操作沒有 NAS 目的地")?;
    let after = smb_wire_path(after_relative, true)?;
    let before = smb_wire_path(&record.before_relative_path, false)?;
    let (mut client, mut tree) = smb_connection(&config).await?;
    let expected = record
        .expected_fingerprint
        .as_deref()
        .ok_or("操作缺少 NAS 位置版本前置條件，已停止還原")?;
    let info = smb_stat_required(&mut client, &mut tree, &after)
        .await
        .map_err(|error| format!("NAS 還原來源不存在或無權限：{error}"))?;
    let current = smb_location_revision(
        &record.source_id,
        &record.before_relative_path,
        info.size,
        info.modified.0,
    );
    if current != expected {
        return Err("NAS 還原來源位置已變更，已停止還原".into());
    }
    if smb_stat_optional(&mut client, &mut tree, &before)
        .await?
        .is_some()
    {
        return Err("NAS 原位置已有其他項目，已停止還原".into());
    }
    smb_rename(&mut client, &mut tree, &after, &before).await?;
    let runtime_id = smb_runtime_id(&record.before_relative_path);
    let operation_id = record.id.clone();
    let completed = catalog_call(store, move |store| {
        store.complete_file_operation_undo(&operation_id, Some(&runtime_id))
    })
    .await;
    if let Err(error) = completed {
        let rollback = smb_rename(&mut client, &mut tree, &before, &after).await;
        return match rollback {
            Ok(()) => Err(format!(
                "目錄還原失敗，NAS 檔案已退回隔離／移動位置：{error}"
            )),
            Err(rollback_error) => {
                let failure = format!(
                    "目錄還原失敗，且 NAS 檔案退回也失敗（需要人工檢查）：{error}; rollback: {rollback_error}"
                );
                let operation_id = record.id.clone();
                let message = failure.clone();
                let _ = catalog_call(store, move |store| {
                    store.mark_file_operation_needs_reconcile(&operation_id, &message)
                })
                .await;
                Err(failure)
            }
        };
    }
    if record.action == "trash" {
        if let Some((directory, _)) = after.rsplit_once('\\') {
            remove_smb_directory_if_empty(&mut client, &mut tree, directory).await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{ComicItem, Progress};

    #[test]
    fn relative_destination_rejects_escape_reserved_and_windows_separator() {
        assert!(clean_relative("../outside.cbz").is_err());
        assert!(clean_relative("/outside.cbz").is_err());
        assert!(clean_relative(".gai-quarantine/stolen.cbz").is_err());
        assert!(clean_relative("series\\..\\outside.cbz").is_err());
        assert_eq!(
            clean_relative("系列/作品.cbz").unwrap(),
            PathBuf::from("系列/作品.cbz")
        );
    }

    #[test]
    fn smb_wire_paths_reject_cross_platform_traversal() {
        assert_eq!(
            smb_wire_path("series/book.cbz", false).unwrap(),
            "series\\book.cbz"
        );
        assert!(smb_wire_path("series\\..\\book.cbz", false).is_err());
        assert!(smb_wire_path("../book.cbz", false).is_err());
        assert!(smb_wire_path(".gai-quarantine/a/book.cbz", false).is_err());
        assert!(smb_wire_path(".gai-quarantine/a/book.cbz", true).is_ok());
    }

    #[test]
    fn smb_runtime_ids_are_distinct_from_local_ids() {
        let relative = "series/book.cbz";
        assert_ne!(
            smb_runtime_id(relative),
            general_purpose::URL_SAFE_NO_PAD.encode(relative.as_bytes())
        );
    }

    #[cfg(unix)]
    #[test]
    fn local_mutation_parent_open_rejects_symlink_components() {
        use std::os::unix::fs::symlink;

        let base =
            std::env::temp_dir().join(format!("gai-file-op-symlink-{}", uuid::Uuid::new_v4()));
        let root_path = base.join("library");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root_path).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root_path.join("escape")).unwrap();
        let root =
            cap_std::fs::Dir::open_ambient_dir(&root_path, cap_std::ambient_authority()).unwrap();

        assert!(open_local_parent(&root, Path::new("escape/book.cbz"), false).is_err());

        drop(root);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn local_root_open_rejects_replaced_root_symlink() {
        use std::os::unix::fs::symlink;

        let base =
            std::env::temp_dir().join(format!("gai-file-op-root-symlink-{}", uuid::Uuid::new_v4()));
        let root_path = base.join("library");
        let moved_root = base.join("library-moved");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root_path).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let canonical_root = root_path.canonicalize().unwrap();
        std::fs::rename(&root_path, &moved_root).unwrap();
        symlink(&outside, &root_path).unwrap();

        assert!(open_local_root(&canonical_root).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "linux"))]
    #[test]
    fn local_noreplace_preserves_existing_destination() {
        let base =
            std::env::temp_dir().join(format!("gai-file-op-noreplace-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("source"), b"source").unwrap();
        std::fs::write(base.join("target"), b"target").unwrap();
        let root = cap_std::fs::Dir::open_ambient_dir(&base, cap_std::ambient_authority()).unwrap();

        assert!(rename_noreplace(&root, Path::new("source"), &root, Path::new("target")).is_err());
        assert_eq!(std::fs::read(base.join("source")).unwrap(), b"source");
        assert_eq!(std::fs::read(base.join("target")).unwrap(), b"target");

        drop(root);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn capability_exposes_revision_and_fails_closed_without_one() {
        let location = ComicLocationView {
            id: 1,
            comic_id: "comic".into(),
            runtime_id: Some("runtime".into()),
            source_id: "local:test".into(),
            relative_path: "book.cbz".into(),
            actual_path: Some("/tmp/book.cbz".into()),
            kind: "archive".into(),
            size: Some(42),
            mtime: Some("2026-09-01T00:00:00Z".into()),
            fingerprint: None,
            fingerprint_collision: false,
            online: true,
        };
        let result = capability(&location, false);
        assert_eq!(
            result.expected_fingerprint.as_deref(),
            Some(
                "location-revision-v1:{\"mtime\":\"2026-09-01T00:00:00Z\",\"path\":\"book.cbz\",\"size\":42,\"source\":\"local:test\"}"
            )
        );
        assert!(result.can_rename);

        let mut unavailable = location;
        unavailable.size = None;
        unavailable.mtime = None;
        let result = capability(&unavailable, false);
        assert!(result.expected_fingerprint.is_none());
        assert!(!result.can_rename);
        assert!(!result.can_move);
        assert!(!result.can_trash);

        unavailable.fingerprint = Some("shared-sampled-value".into());
        unavailable.size = Some(42);
        unavailable.mtime = Some("2026-09-01T00:00:00Z".into());
        unavailable.fingerprint_collision = true;
        let result = capability(&unavailable, false);
        assert!(result.expected_fingerprint.is_none());
        assert!(!result.can_rename);
    }

    #[test]
    fn local_rename_trash_and_undo_keep_identity_without_empty_quarantine_tombs() {
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
        let expected_fingerprint = registered_fingerprint(&location);
        let result = mutate_local(
            &store,
            location,
            FileMutationRequest {
                comic_id: runtime_id,
                action: "rename".into(),
                destination_relative_path: Some("renamed".into()),
                expected_fingerprint,
            },
        )
        .unwrap();
        assert!(!original.exists());
        assert!(root.join("renamed").exists());
        let renamed = store.get_runtime_item(&stable_id).unwrap().unwrap();
        assert_eq!(renamed.relative_path, "renamed");
        assert_eq!(renamed.progress.current_page, 3);
        assert_eq!(
            store
                .search(CatalogQuery {
                    query: "renamed".into(),
                    offset: 0,
                    limit: 20,
                })
                .unwrap()
                .total,
            1
        );
        let operation = store.file_operation_for_undo(&result.undo_token).unwrap();
        undo_local(&store, &operation).unwrap();
        assert!(original.exists());
        assert!(!root.join("renamed").exists());
        let restored = store.get_runtime_item(&stable_id).unwrap().unwrap();
        assert_eq!(restored.relative_path, "book");
        assert_eq!(restored.progress.current_page, 3);
        assert_eq!(
            store
                .search(CatalogQuery {
                    query: "renamed".into(),
                    offset: 0,
                    limit: 20,
                })
                .unwrap()
                .total,
            0
        );

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

        let location = store.get_location(&stable_id).unwrap();
        let expected_fingerprint = registered_fingerprint(&location);
        let trash = mutate_local(
            &store,
            location,
            FileMutationRequest {
                comic_id: stable_id.clone(),
                action: "trash".into(),
                destination_relative_path: None,
                expected_fingerprint,
            },
        )
        .unwrap();
        let trash_operation = store.file_operation_for_undo(&trash.undo_token).unwrap();
        let quarantine_root = root.join(".gai-quarantine").join("comics");
        let mut directories = std::fs::read_dir(&quarantine_root)
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        directories.sort();
        assert_eq!(directories, vec![trash_operation.id.clone()]);
        undo_local(&store, &trash_operation).unwrap();
        assert!(original.exists());
        assert!(!quarantine_root.join(&trash_operation.id).exists());

        let location = store.get_location(&stable_id).unwrap();
        let pending_operation = store
            .begin_file_operation(
                &location,
                "rename",
                Some("pending-review"),
                Some(&root.join("pending-review").to_string_lossy()),
            )
            .unwrap();
        store
            .mark_file_operation_needs_reconcile(&pending_operation.id, "pending 雙失敗 fixture")
            .unwrap();
        assert_eq!(
            store
                .file_operation_for_undo(&pending_operation.undo_token)
                .unwrap()
                .status,
            "needs_reconcile"
        );

        // Exercise the actual undo error path: force the catalog CAS to fail,
        // then inject a destination collision so its filesystem rollback fails.
        let location = store.get_location(&stable_id).unwrap();
        let double_fault = mutate_local(
            &store,
            location,
            FileMutationRequest {
                comic_id: stable_id.clone(),
                action: "rename".into(),
                destination_relative_path: Some("double-fault".into()),
                expected_fingerprint: registered_fingerprint(
                    &store.get_location(&stable_id).unwrap(),
                ),
            },
        )
        .unwrap();
        let double_fault_operation = store
            .file_operation_for_undo(&double_fault.undo_token)
            .unwrap();
        store
            .test_set_location_relative_path(double_fault_operation.location_id, "catalog-diverged")
            .unwrap();
        UNDO_TEST_FORCE_ROLLBACK_COLLISION.store(true, Ordering::SeqCst);
        let error = undo_local(&store, &double_fault_operation).unwrap_err();
        assert!(error.contains("需要人工檢查"));
        assert_eq!(
            store
                .file_operation_for_undo(&double_fault_operation.undo_token)
                .unwrap()
                .status,
            "needs_reconcile"
        );
        std::fs::remove_file(root.join("double-fault")).unwrap();

        drop(store);
        let _ = std::fs::remove_dir_all(&base);
    }
}
