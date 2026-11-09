//! Strict identity helpers for an app's own iOS Documents container.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::path::Path;

/// Return the UUID of an exact iOS app Documents root, accepting `/private` as
/// the filesystem alias used by some iOS APIs.
pub(crate) fn documents_container_id(root: &str) -> Option<uuid::Uuid> {
    let root = root.strip_prefix("/private").unwrap_or(root);
    let rest = root.strip_prefix("/var/mobile/Containers/Data/Application/")?;
    let (container, suffix) = rest.split_once('/')?;
    if suffix != "Documents" || container.len() != 36 {
        return None;
    }
    let uuid = uuid::Uuid::parse_str(container).ok()?;
    uuid.to_string()
        .eq_ignore_ascii_case(container)
        .then_some(uuid)
}

/// Validate a trusted native Documents path and produce its catalog identity.
#[cfg(any(target_os = "ios", test))]
pub(crate) fn current_documents_source_id(documents: &Path) -> Option<String> {
    let root = documents.to_str()?;
    documents_container_id(root)?;
    Some(crate::scanner::local_source_id(documents))
}

/// Confirm two exact Documents roots name the same container UUID, allowing
/// the native `/private/var` filesystem alias without rewriting source IDs.
#[cfg(any(target_os = "ios", test))]
pub(crate) fn same_documents_root(first: &Path, second: &Path) -> bool {
    first
        .to_str()
        .and_then(documents_container_id)
        .zip(second.to_str().and_then(documents_container_id))
        .is_some_and(|(first, second)| first == second)
}

/// Check whether a stored local source ID belongs to another app Documents
/// container. External roots and malformed IDs are deliberately excluded.
pub(crate) fn is_previous_documents_source_id(source_id: &str, current_documents: &Path) -> bool {
    let Some(current_source_id) = current_documents.to_str().and_then(|root| {
        documents_container_id(root)?;
        Some(crate::scanner::local_source_id(current_documents))
    }) else {
        return false;
    };
    let Some(encoded) = source_id.strip_prefix("local:") else {
        return false;
    };
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(encoded) else {
        return false;
    };
    let Ok(saved_root) = std::str::from_utf8(&bytes) else {
        return false;
    };
    // Accept only the canonical encoding emitted by scanner::local_source_id.
    if URL_SAFE_NO_PAD.encode(saved_root.as_bytes()) != encoded {
        return false;
    }
    documents_container_id(saved_root).is_some() && source_id != current_source_id
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const CURRENT: &str = "/private/var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents";
    const OLD: &str =
        "/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents";

    fn source_id(path: &str) -> String {
        format!("local:{}", URL_SAFE_NO_PAD.encode(path.as_bytes()))
    }

    #[test]
    fn accepts_private_alias_and_unicode_paths_but_only_exact_roots() {
        let uuid = documents_container_id(CURRENT).unwrap();
        assert_eq!(uuid.to_string(), "22222222-2222-4222-8222-222222222222");
        assert_eq!(
            documents_container_id(OLD),
            Some(uuid::Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap())
        );
        for invalid in [
            "/private/var/mobile/Containers/Shared/AppGroup/provider/Documents",
            "/private/var/mobile/Containers/Data/Application/not-a-container/Documents",
            "/private/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/子目錄",
            "/private/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/../Library",
            "/private/var/mobile/Containers/Data/Application/11111111111141118111111111111111/Documents",
            "/private/var/mobile/Containers/Data/Application/urn:uuid:11111111-1111-4111-8111-111111111111/Documents",
            "/private/var/mobile/Containers/Data/Application/{11111111-1111-4111-8111-111111111111}/Documents",
            "/mnt/external/Documents",
        ] {
            assert!(documents_container_id(invalid).is_none(), "{invalid}");
        }
        assert!(current_documents_source_id(Path::new(CURRENT)).is_some());
        assert!(current_documents_source_id(Path::new("/mnt/外部/Documents")).is_none());
    }

    #[test]
    fn recognizes_only_well_formed_previous_documents_source_ids() {
        assert!(is_previous_documents_source_id(
            &source_id(OLD),
            Path::new(CURRENT)
        ));
        assert!(is_previous_documents_source_id(
            &source_id(CURRENT.strip_prefix("/private").unwrap()),
            Path::new(CURRENT)
        ));
        assert!(!is_previous_documents_source_id(
            &source_id(CURRENT),
            Path::new(CURRENT)
        ));
        assert!(!is_previous_documents_source_id(
            &source_id("/Volumes/NAS/Documents"),
            Path::new(CURRENT)
        ));
        assert!(!is_previous_documents_source_id(
            "local:%%%",
            Path::new(CURRENT)
        ));
        assert!(!is_previous_documents_source_id(
            "local:/w==",
            Path::new(CURRENT)
        ));
        assert!(!is_previous_documents_source_id(
            &source_id(OLD),
            Path::new("/Volumes/外部/Documents")
        ));
    }

    #[test]
    fn same_documents_root_accepts_only_private_var_alias_for_same_uuid() {
        assert!(same_documents_root(
            Path::new(CURRENT),
            Path::new(CURRENT.strip_prefix("/private").unwrap())
        ));
        assert!(!same_documents_root(Path::new(CURRENT), Path::new(OLD)));
        assert!(!same_documents_root(
            Path::new(CURRENT),
            Path::new("/Volumes/External/Documents")
        ));
    }
}
