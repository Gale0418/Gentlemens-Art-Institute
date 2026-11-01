//! Safe recovery for a damaged persisted external-bookmark list.
//!
//! This module deliberately does not perform legacy-cache migration or look at
//! any other source of bookmarks.  The caller supplies the newly selected
//! sources after an explicit user confirmation, and this module only touches
//! the persisted file plus UUID-named siblings in the same directory.

use crate::state::ExternalBookmark;
use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Input accepted by [`recover_external_bookmarks`].
///
/// `user_confirmed` must be set by the UI flow that showed the recovery
/// warning.  `new_sources` must be the sources selected in that same flow;
/// this module never obtains or merges sources from a legacy cache.
#[derive(Debug, Clone)]
pub struct RecoveryRequest {
    pub user_confirmed: bool,
    pub new_sources: Vec<ExternalBookmark>,
}

#[derive(Debug, Clone)]
pub enum BookmarkFileState {
    Missing,
    Valid(Vec<ExternalBookmark>),
    Damaged { bytes: Vec<u8>, reason: String },
}

impl BookmarkFileState {
    /// Returns the parsed list when the file is valid, including `[]`.
    #[must_use]
    pub fn valid_bookmarks(&self) -> Option<&[ExternalBookmark]> {
        match self {
            Self::Valid(bookmarks) => Some(bookmarks),
            Self::Missing | Self::Damaged { .. } => None,
        }
    }

    /// Returns the exact bytes and serde diagnostic for a damaged file.
    #[must_use]
    pub fn damaged_details(&self) -> Option<(&[u8], &str)> {
        match self {
            Self::Damaged { bytes, reason } => Some((bytes, reason)),
            Self::Missing | Self::Valid(_) => None,
        }
    }
}

#[derive(Debug)]
pub enum RecoveryOutcome {
    /// No persisted file existed.  Recovery intentionally does not create it.
    NotFound,
    /// The existing file was valid (including an explicit `[]`).
    AlreadyValid(Vec<ExternalBookmark>),
    /// The damaged file was backed up and replaced with the selected sources.
    Recovered {
        bookmarks: Vec<ExternalBookmark>,
        backup_path: PathBuf,
    },
    /// The destination was atomically renamed, but a post-commit durability
    /// or read-back check could not complete.  `bookmarks` is the exact list
    /// serialized into the verified temporary file; callers should commit it
    /// to memory and surface `warning` instead of treating this as a rollback.
    CommittedWithWarning {
        bookmarks: Vec<ExternalBookmark>,
        backup_path: PathBuf,
        warning: RecoveryWarning,
    },
}

#[derive(Debug)]
pub enum RecoveryWarning {
    ParentDirectorySyncFailed { source: io::Error },
    ReadBackFailed { source: io::Error },
    ReadBackSchemaInvalid { message: String },
    ReadBackContentMismatch,
}

impl RecoveryOutcome {
    /// Sources written by a successful rename, including a warning outcome.
    #[must_use]
    pub fn committed_bookmarks(&self) -> Option<&[ExternalBookmark]> {
        match self {
            Self::Recovered { bookmarks, .. } | Self::CommittedWithWarning { bookmarks, .. } => {
                Some(bookmarks)
            }
            Self::NotFound | Self::AlreadyValid(_) => None,
        }
    }

    /// Backup path for a committed recovery, whether or not post-commit
    /// durability/read-back checks completed.
    #[must_use]
    pub fn backup_path(&self) -> Option<&Path> {
        match self {
            Self::Recovered { backup_path, .. }
            | Self::CommittedWithWarning { backup_path, .. } => Some(backup_path),
            Self::NotFound | Self::AlreadyValid(_) => None,
        }
    }

    /// Post-commit warning, if rename succeeded but confirmation was partial.
    #[must_use]
    pub fn warning(&self) -> Option<&RecoveryWarning> {
        match self {
            Self::CommittedWithWarning { warning, .. } => Some(warning),
            Self::NotFound | Self::AlreadyValid(_) | Self::Recovered { .. } => None,
        }
    }
}

impl fmt::Display for RecoveryWarning {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ParentDirectorySyncFailed { source } => {
                write!(
                    formatter,
                    "bookmark file committed, but directory sync failed: {source}"
                )
            }
            Self::ReadBackFailed { source } => {
                write!(
                    formatter,
                    "bookmark file committed, but read-back failed: {source}"
                )
            }
            Self::ReadBackSchemaInvalid { message } => write!(
                formatter,
                "bookmark file committed, but read-back schema validation failed: {message}"
            ),
            Self::ReadBackContentMismatch => write!(
                formatter,
                "bookmark file committed, but read-back bytes differ from the verified replacement"
            ),
        }
    }
}

#[derive(Debug)]
pub enum RecoveryError {
    InvalidRequest(&'static str),
    Read { path: PathBuf, source: io::Error },
    Backup { path: PathBuf, source: io::Error },
    Temporary { path: PathBuf, source: io::Error },
    ConcurrentChange { path: PathBuf },
    Commit { path: PathBuf, source: io::Error },
    Verify { path: PathBuf, message: String },
}

impl fmt::Display for RecoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(message) => {
                write!(formatter, "invalid recovery request: {message}")
            }
            Self::Read { path, source } => {
                write!(formatter, "cannot read {}: {source}", path.display())
            }
            Self::Backup { path, source } => write!(
                formatter,
                "cannot create backup {}: {source}",
                path.display()
            ),
            Self::Temporary { path, source } => write!(
                formatter,
                "cannot write temporary file {}: {source}",
                path.display()
            ),
            Self::ConcurrentChange { path } => write!(
                formatter,
                "bookmark file changed during recovery: {}",
                path.display()
            ),
            Self::Commit { path, source } => write!(
                formatter,
                "cannot atomically replace {}: {source}",
                path.display()
            ),
            Self::Verify { path, message } => write!(
                formatter,
                "recovery verification failed for {}: {message}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for RecoveryError {}

/// Classify the persisted file without writing anything.
///
/// A missing file and an I/O error are not damage.  A readable file is
/// considered damaged only when its JSON or bookmark schema is invalid.
pub fn inspect_external_bookmarks(path: &Path) -> Result<BookmarkFileState, RecoveryError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(BookmarkFileState::Missing);
        }
        Err(source) => {
            return Err(RecoveryError::Read {
                path: path.to_path_buf(),
                source,
            });
        }
    };

    match decode_bookmarks(&bytes) {
        Ok(bookmarks) => Ok(BookmarkFileState::Valid(bookmarks)),
        Err(reason) => Ok(BookmarkFileState::Damaged { bytes, reason }),
    }
}

/// Recover a damaged file using only explicitly confirmed, newly selected
/// sources.
///
/// The destination is never removed first.  A UUID-named sibling backup is
/// created with `create_new`, fully written and `sync_all`'d before an atomic
/// temporary-file rename.  The backup is retained even if a later commit step
/// fails, so the original damaged bytes remain recoverable.
pub fn recover_external_bookmarks(
    path: &Path,
    request: RecoveryRequest,
) -> Result<RecoveryOutcome, RecoveryError> {
    validate_request(&request)?;

    let state = inspect_external_bookmarks(path)?;
    if let Some(bookmarks) = state.valid_bookmarks() {
        log::debug!(
            "Existing external bookmark list has {} entries",
            bookmarks.len()
        );
    }
    if let Some((_, reason)) = state.damaged_details() {
        log::warn!("Recovering damaged external bookmark list: {reason}");
    }
    let BookmarkFileState::Damaged { bytes, .. } = state else {
        return Ok(match state {
            BookmarkFileState::Missing => RecoveryOutcome::NotFound,
            BookmarkFileState::Valid(bookmarks) => RecoveryOutcome::AlreadyValid(bookmarks),
            BookmarkFileState::Damaged { .. } => unreachable!(),
        });
    };

    // Do not back up stale bytes if another writer changed the destination
    // between inspection and recovery.  The lifecycle lock at the call site
    // should make this unlikely; this check is still cheap and defensive.
    ensure_unchanged(path, &bytes)?;

    let (backup_path, mut backup_file) =
        create_unique_sibling(path, "corrupt-backup").map_err(|source| RecoveryError::Backup {
            path: path.to_path_buf(),
            source,
        })?;
    if let Err(source) = write_and_sync(&mut backup_file, &bytes) {
        drop(backup_file);
        let _ = fs::remove_file(&backup_path);
        return Err(RecoveryError::Backup {
            path: backup_path,
            source,
        });
    }
    drop(backup_file);

    // Recheck after creating the backup.  A changed destination is never
    // overwritten, while the unique backup remains useful evidence.
    ensure_unchanged(path, &bytes)?;

    let replacement =
        serde_json::to_vec(&request.new_sources).map_err(|error| RecoveryError::Verify {
            path: path.to_path_buf(),
            message: format!("cannot serialize selected sources: {error}"),
        })?;
    // Serialization should produce valid data, but parse the exact bytes that
    // will be written so a future schema change cannot bypass verification.
    decode_bookmarks(&replacement).map_err(|reason| RecoveryError::Verify {
        path: path.to_path_buf(),
        message: format!("serialized selected sources are invalid: {reason}"),
    })?;

    let (temporary_path, mut temporary_file) = create_unique_sibling(path, "recovery-tmp")
        .map_err(|source| RecoveryError::Temporary {
            path: path.to_path_buf(),
            source,
        })?;
    if let Err(source) = write_and_sync(&mut temporary_file, &replacement) {
        drop(temporary_file);
        let _ = fs::remove_file(&temporary_path);
        return Err(RecoveryError::Temporary {
            path: temporary_path,
            source,
        });
    }
    drop(temporary_file);

    let temporary_bytes = fs::read(&temporary_path).map_err(|source| RecoveryError::Temporary {
        path: temporary_path.clone(),
        source,
    })?;
    if temporary_bytes != replacement {
        let _ = fs::remove_file(&temporary_path);
        return Err(RecoveryError::Verify {
            path: temporary_path,
            message: "temporary file bytes differ from the selected sources".into(),
        });
    }
    let _verified_bookmarks = decode_bookmarks(&temporary_bytes).map_err(|reason| {
        let _ = fs::remove_file(&temporary_path);
        RecoveryError::Verify {
            path: temporary_path.clone(),
            message: format!("temporary file schema is invalid: {reason}"),
        }
    })?;

    ensure_unchanged(path, &bytes)?;
    fs::rename(&temporary_path, path).map_err(|source| {
        let _ = fs::remove_file(&temporary_path);
        RecoveryError::Commit {
            path: path.to_path_buf(),
            source,
        }
    })?;
    // `rename` succeeded, so every branch below is a committed outcome.  A
    // failed directory sync weakens durability but must not be reported as a
    // total failure: the destination has already changed.
    let mut warning = sync_parent(path)
        .err()
        .map(|source| RecoveryWarning::ParentDirectorySyncFailed { source });
    let committed_bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(source) => {
            warning = Some(RecoveryWarning::ReadBackFailed { source });
            return Ok(RecoveryOutcome::CommittedWithWarning {
                bookmarks: request.new_sources,
                backup_path,
                warning: warning.expect("read-back failure supplies a warning"),
            });
        }
    };
    let committed_bookmarks = match decode_bookmarks(&committed_bytes) {
        Ok(bookmarks) => bookmarks,
        Err(message) => {
            warning = Some(RecoveryWarning::ReadBackSchemaInvalid { message });
            return Ok(RecoveryOutcome::CommittedWithWarning {
                bookmarks: request.new_sources,
                backup_path,
                warning: warning.expect("schema failure supplies a warning"),
            });
        }
    };
    if committed_bytes != replacement {
        warning = Some(RecoveryWarning::ReadBackContentMismatch);
        return Ok(RecoveryOutcome::CommittedWithWarning {
            bookmarks: request.new_sources,
            backup_path,
            warning: warning.expect("content mismatch supplies a warning"),
        });
    }

    if let Some(warning) = warning {
        Ok(RecoveryOutcome::CommittedWithWarning {
            bookmarks: committed_bookmarks,
            backup_path,
            warning,
        })
    } else {
        Ok(RecoveryOutcome::Recovered {
            bookmarks: committed_bookmarks,
            backup_path,
        })
    }
}

fn validate_request(request: &RecoveryRequest) -> Result<(), RecoveryError> {
    if !request.user_confirmed {
        return Err(RecoveryError::InvalidRequest(
            "explicit user confirmation is required",
        ));
    }
    if request.new_sources.is_empty() {
        return Err(RecoveryError::InvalidRequest(
            "at least one newly selected source is required",
        ));
    }

    let mut seen = HashSet::with_capacity(request.new_sources.len());
    for source in &request.new_sources {
        if source.bookmark.trim().is_empty() {
            return Err(RecoveryError::InvalidRequest(
                "a selected source must contain a bookmark",
            ));
        }
        if !seen.insert(&source.bookmark) {
            return Err(RecoveryError::InvalidRequest(
                "selected sources must not contain duplicate bookmarks",
            ));
        }
    }
    Ok(())
}

fn decode_bookmarks(bytes: &[u8]) -> Result<Vec<ExternalBookmark>, String> {
    serde_json::from_slice(bytes).map_err(|error| error.to_string())
}

fn ensure_unchanged(path: &Path, expected: &[u8]) -> Result<(), RecoveryError> {
    let current = fs::read(path).map_err(|source| RecoveryError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    if current != expected {
        return Err(RecoveryError::ConcurrentChange {
            path: path.to_path_buf(),
        });
    }
    Ok(())
}

fn create_unique_sibling(path: &Path, purpose: &str) -> io::Result<(PathBuf, File)> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "bookmark path has no file name",
            )
        })?
        .to_string_lossy();
    for _ in 0..16 {
        let candidate = parent.join(format!(".{name}.{purpose}-{}", Uuid::new_v4()));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique sibling path",
    ))
}

fn write_and_sync(file: &mut File, bytes: &[u8]) -> io::Result<()> {
    file.write_all(bytes)?;
    file.sync_all()
}

fn sync_parent(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path.parent().unwrap_or_else(|| Path::new(".")))?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temporary_dir(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("gai-bookmark-recovery-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn request() -> RecoveryRequest {
        RecoveryRequest {
            user_confirmed: true,
            new_sources: vec![ExternalBookmark {
                bookmark: "new-grant".into(),
                name: "New source".into(),
            }],
        }
    }

    #[test]
    fn inspection_distinguishes_missing_valid_empty_and_damaged() {
        let directory = temporary_dir("inspection");
        let path = directory.join("external-bookmarks.json");
        assert!(matches!(
            inspect_external_bookmarks(&path).unwrap(),
            BookmarkFileState::Missing
        ));

        fs::write(&path, b"[]").unwrap();
        assert!(matches!(
            inspect_external_bookmarks(&path).unwrap(),
            BookmarkFileState::Valid(values) if values.is_empty()
        ));

        let damaged = b"[{\"bookmark\":\"old\"}]";
        fs::write(&path, damaged).unwrap();
        match inspect_external_bookmarks(&path).unwrap() {
            BookmarkFileState::Damaged { bytes, reason } => {
                assert_eq!(bytes, damaged);
                assert!(
                    reason.contains("missing field `name`")
                        || reason.contains("missing field name")
                );
            }
            other => panic!("expected damaged state, got {other:?}"),
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn recovery_requires_confirmation_and_a_new_source_without_writing() {
        let directory = temporary_dir("request");
        let path = directory.join("external-bookmarks.json");
        let original = b"not JSON";
        fs::write(&path, original).unwrap();

        let error = recover_external_bookmarks(
            &path,
            RecoveryRequest {
                user_confirmed: false,
                new_sources: request().new_sources,
            },
        )
        .unwrap_err();
        assert!(matches!(error, RecoveryError::InvalidRequest(_)));
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);

        let error = recover_external_bookmarks(
            &path,
            RecoveryRequest {
                user_confirmed: true,
                new_sources: Vec::new(),
            },
        )
        .unwrap_err();
        assert!(matches!(error, RecoveryError::InvalidRequest(_)));
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn recovery_preserves_exact_corrupt_bytes_and_replaces_atomically() {
        let directory = temporary_dir("commit");
        let path = directory.join("external-bookmarks.json");
        let original = b"{ definitely not JSON }\0";
        fs::write(&path, original).unwrap();

        let outcome = recover_external_bookmarks(&path, request()).unwrap();
        assert_eq!(
            outcome.committed_bookmarks().expect("committed sources")[0]
                .bookmark
                .as_str(),
            "new-grant"
        );
        assert!(outcome.backup_path().is_some());
        assert!(outcome.warning().is_none());
        let RecoveryOutcome::Recovered {
            bookmarks,
            backup_path,
        } = outcome
        else {
            panic!("expected a recovery");
        };
        assert_eq!(bookmarks[0].bookmark, "new-grant");
        assert_eq!(fs::read(&backup_path).unwrap(), original);
        assert_eq!(
            fs::read(&path).unwrap(),
            serde_json::to_vec(&request().new_sources).unwrap()
        );
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);
        assert!(backup_path.parent().unwrap() == directory);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn committed_warning_exposes_sources_backup_and_warning_to_callers() {
        let backup_path = PathBuf::from("/tmp/external-bookmarks.corrupt-backup-test");
        let outcome = RecoveryOutcome::CommittedWithWarning {
            bookmarks: request().new_sources,
            backup_path: backup_path.clone(),
            warning: RecoveryWarning::ReadBackContentMismatch,
        };
        assert_eq!(
            outcome.committed_bookmarks().expect("committed sources")[0]
                .bookmark
                .as_str(),
            "new-grant"
        );
        assert_eq!(outcome.backup_path(), Some(backup_path.as_path()));
        assert!(matches!(
            outcome.warning(),
            Some(RecoveryWarning::ReadBackContentMismatch)
        ));
        assert!(outcome.warning().unwrap().to_string().contains("committed"));
    }

    #[test]
    fn valid_empty_list_is_never_recovered_or_overwritten() {
        let directory = temporary_dir("empty");
        let path = directory.join("external-bookmarks.json");
        fs::write(&path, b"[]").unwrap();
        let outcome = recover_external_bookmarks(&path, request()).unwrap();
        assert!(matches!(outcome, RecoveryOutcome::AlreadyValid(values) if values.is_empty()));
        assert_eq!(fs::read(&path).unwrap(), b"[]");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn read_errors_are_not_classified_as_damage() {
        let directory = temporary_dir("read-error");
        let path = directory.join("external-bookmarks.json");
        fs::create_dir(&path).unwrap();
        let error = inspect_external_bookmarks(&path).unwrap_err();
        assert!(matches!(error, RecoveryError::Read { .. }));
        fs::remove_dir_all(directory).unwrap();
    }
}
