//! Pro 權益只從原生 StoreKit 取得；不接受 WebView 提供的購買旗標。
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

pub const PRO_PRODUCT_ID: &str = "com.windsheep.gai.pro.v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommerceStatus {
    pub supported: bool,
    pub pro: bool,
    pub product_id: String,
    pub display_price: Option<String>,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum CommerceAction {
    Status,
    Purchase,
    Restore,
}

pub async fn status(app: &AppHandle, action: CommerceAction) -> Result<CommerceStatus, String> {
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_ios_folder::TauriPluginIosFolderExt;
        let app = app.clone();
        let raw = tauri::async_runtime::spawn_blocking(move || {
            app.tauri_plugin_ios_folder().commerce(match action {
                CommerceAction::Status => "getCommerce",
                CommerceAction::Purchase => "purchasePro",
                CommerceAction::Restore => "restorePro",
            })
        })
        .await
        .map_err(|_| "無法取得商店狀態，請稍後再試".to_string())?
        .map_err(|_| "無法連線到 Apple 商店，請稍後再試".to_string())?;
        let status: CommerceStatus =
            serde_json::from_value(raw).map_err(|_| "商店回覆格式不正確".to_string())?;
        if status.product_id != PRO_PRODUCT_ID {
            return Err("商店商品與此版本不符".into());
        }
        Ok(status)
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        if !matches!(action, CommerceAction::Status) {
            return Err("此版本未提供 App Store 購買，桌面功能維持可用".into());
        }
        // 目前只發行 iOS IAP；保留既有直接分發的桌面版行為。
        Ok(CommerceStatus {
            supported: false,
            pro: true,
            product_id: PRO_PRODUCT_ID.into(),
            display_price: None,
            status: "desktop".into(),
            message: Some("桌面版功能可用；此版本不提供 App Store 購買".into()),
        })
    }
}

pub async fn require_pro(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_ios_folder::TauriPluginIosFolderExt;
        let app = app.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            app.tauri_plugin_ios_folder().commerce("checkPro")
        })
        .await
        .map_err(|_| "暫時無法確認 Pro 權益，請稍後再試".to_string())?
        .map_err(|_| "暫時無法確認 Pro 權益，請稍後再試".to_string())?;
        authorize(result.get("pro").and_then(|value| value.as_bool()) == Some(true))
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        authorize(true)
    }
}

fn authorize(pro: bool) -> Result<(), String> {
    if pro {
        Ok(())
    } else {
        Err("PRO_REQUIRED: 這項功能需要 G.A.I Pro；基本閱讀、資料匯出與復原仍可使用".into())
    }
}

pub fn is_batch(ids: &[String]) -> bool {
    ids.iter().collect::<std::collections::BTreeSet<_>>().len() > 1
}

pub fn is_direct_smb(source_id: &str, item_type: &str) -> bool {
    source_id == "smb" || item_type == "smb-archive"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unowned_pro_actions_fail_closed() {
        assert!(authorize(false).unwrap_err().starts_with("PRO_REQUIRED:"));
        assert!(authorize(true).is_ok());
    }

    #[test]
    fn single_comic_edits_remain_free_even_with_duplicate_ids() {
        assert!(!is_batch(&[]));
        assert!(!is_batch(&["one".into(), "one".into()]));
        assert!(is_batch(&["one".into(), "two".into()]));
    }

    #[test]
    fn mounted_nas_is_not_mistaken_for_direct_smb() {
        assert!(!is_direct_smb("local:/Volumes/NAS", "archive"));
        assert!(!is_direct_smb("external:nas-bookmark", "external-archive"));
        assert!(is_direct_smb("smb", "archive"));
        assert!(is_direct_smb("legacy", "smb-archive"));
    }
}
