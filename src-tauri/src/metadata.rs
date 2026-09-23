use chardetng::EncodingDetector;
use encoding_rs::{Encoding, UTF_8};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_METADATA_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct ScopedTag {
    pub namespace: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedMetadata {
    pub title: Option<String>,
    pub series: Option<String>,
    pub volume: Option<String>,
    pub number: Option<String>,
    pub summary: Option<String>,
    pub language: Option<String>,
    pub reading_direction: Option<String>,
    pub published_at: Option<String>,
    pub creators: BTreeMap<String, Vec<String>>,
    pub tags: Vec<ScopedTag>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedMetadataSource {
    pub parser_id: String,
    pub parser_version: String,
    pub priority: i64,
    pub confidence: f64,
    pub source_path: String,
    pub source_digest: String,
    pub raw_json: Value,
    pub metadata: NormalizedMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParserDiagnostic {
    pub parser_id: Option<String>,
    pub source_path: String,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Default)]
pub struct ParseOutcome {
    pub sources: Vec<ParsedMetadataSource>,
    pub diagnostics: Vec<ParserDiagnostic>,
}

struct ParseContext<'a> {
    source_path: &'a str,
    bytes: &'a [u8],
    text: Option<&'a str>,
}

trait MetadataParser: Send + Sync {
    fn parser_id(&self) -> &'static str;
    fn parser_version(&self) -> &'static str {
        "1"
    }
    fn priority(&self) -> i64;
    fn probe(&self, context: &ParseContext<'_>) -> u8;
    fn parse(&self, context: &ParseContext<'_>) -> Result<NormalizedMetadata, String>;
}

struct ComicInfoParser;
struct GalleryDlJsonParser;
struct HDoujinJsonParser;
struct HDoujinTextParser;
struct GalleryInfoParser;
struct EhdlTextParser;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "PascalCase")]
struct ComicInfoXml {
    title: Option<String>,
    series: Option<String>,
    number: Option<String>,
    volume: Option<String>,
    summary: Option<String>,
    writer: Option<String>,
    penciller: Option<String>,
    inker: Option<String>,
    colorist: Option<String>,
    letterer: Option<String>,
    cover_artist: Option<String>,
    editor: Option<String>,
    translator: Option<String>,
    genre: Option<String>,
    tags: Option<String>,
    characters: Option<String>,
    teams: Option<String>,
    locations: Option<String>,
    language_iso: Option<String>,
    manga: Option<String>,
    year: Option<i32>,
    month: Option<u32>,
    day: Option<u32>,
}

impl MetadataParser for ComicInfoParser {
    fn parser_id(&self) -> &'static str {
        "comicinfo"
    }
    fn priority(&self) -> i64 {
        100
    }
    fn probe(&self, context: &ParseContext<'_>) -> u8 {
        let text = context.text.unwrap_or_default();
        if context
            .source_path
            .to_ascii_lowercase()
            .ends_with("comicinfo.xml")
            && text.contains("<ComicInfo")
        {
            100
        } else {
            0
        }
    }
    fn parse(&self, context: &ParseContext<'_>) -> Result<NormalizedMetadata, String> {
        let parsed: ComicInfoXml =
            quick_xml::de::from_str(context.text.ok_or("ComicInfo 不是文字資料")?)
                .map_err(|error| format!("ComicInfo.xml 無法解析：{error}"))?;
        let mut creators = BTreeMap::new();
        for (role, value) in [
            ("writer", parsed.writer),
            ("penciller", parsed.penciller),
            ("inker", parsed.inker),
            ("colorist", parsed.colorist),
            ("letterer", parsed.letterer),
            ("cover_artist", parsed.cover_artist),
            ("editor", parsed.editor),
            ("translator", parsed.translator),
        ] {
            let values = split_values(value.as_deref());
            if !values.is_empty() {
                creators.insert(role.to_string(), values);
            }
        }
        let mut tags = Vec::new();
        add_tags(&mut tags, "general", parsed.genre.as_deref());
        add_tags(&mut tags, "general", parsed.tags.as_deref());
        add_tags(&mut tags, "character", parsed.characters.as_deref());
        add_tags(&mut tags, "team", parsed.teams.as_deref());
        add_tags(&mut tags, "location", parsed.locations.as_deref());
        let published_at = parsed.year.map(|year| {
            format!(
                "{year:04}-{:02}-{:02}",
                parsed.month.unwrap_or(1).clamp(1, 12),
                parsed.day.unwrap_or(1).clamp(1, 31)
            )
        });
        Ok(NormalizedMetadata {
            title: clean(parsed.title),
            series: clean(parsed.series),
            volume: clean(parsed.volume),
            number: clean(parsed.number),
            summary: clean(parsed.summary),
            language: clean(parsed.language_iso),
            reading_direction: parsed.manga.and_then(|value| normalize_direction(&value)),
            published_at,
            creators,
            tags: dedupe_tags(tags),
        })
    }
}

impl MetadataParser for GalleryDlJsonParser {
    fn parser_id(&self) -> &'static str {
        "gallery_dl"
    }
    fn priority(&self) -> i64 {
        80
    }
    fn probe(&self, context: &ParseContext<'_>) -> u8 {
        let Ok(value) = serde_json::from_slice::<Value>(context.bytes) else {
            return 0;
        };
        let object = value.as_object();
        if object.is_some_and(|item| {
            item.contains_key("_extractor")
                || item.contains_key("category")
                || item.contains_key("subcategory")
        }) {
            90
        } else if object.is_some_and(|item| {
            item.contains_key("tags")
                && (item.contains_key("title") || item.contains_key("gallery_id"))
        }) {
            65
        } else {
            0
        }
    }
    fn parse(&self, context: &ParseContext<'_>) -> Result<NormalizedMetadata, String> {
        parse_json_metadata(context.bytes, false)
    }
}

impl MetadataParser for HDoujinJsonParser {
    fn parser_id(&self) -> &'static str {
        "hdoujin_json"
    }
    fn priority(&self) -> i64 {
        70
    }
    fn probe(&self, context: &ParseContext<'_>) -> u8 {
        let Ok(value) = serde_json::from_slice::<Value>(context.bytes) else {
            return 0;
        };
        let Some(object) = value.as_object() else {
            return 0;
        };
        let signals = ["artist", "artists", "circle", "parody", "characters", "url"]
            .into_iter()
            .filter(|key| object.contains_key(*key))
            .count();
        if signals >= 2 {
            85
        } else if signals == 1 && object.contains_key("tags") {
            60
        } else {
            0
        }
    }
    fn parse(&self, context: &ParseContext<'_>) -> Result<NormalizedMetadata, String> {
        parse_json_metadata(context.bytes, true)
    }
}

impl MetadataParser for GalleryInfoParser {
    fn parser_id(&self) -> &'static str {
        "galleryinfo"
    }
    fn priority(&self) -> i64 {
        60
    }
    fn probe(&self, context: &ParseContext<'_>) -> u8 {
        let lower = context.source_path.to_ascii_lowercase();
        let text = context.text.unwrap_or_default();
        if lower.ends_with("galleryinfo.txt") {
            100
        } else if text.contains("Gallery URL:")
            || (text.contains("Tags:") && text.contains("Uploader Comment:"))
        {
            75
        } else {
            0
        }
    }
    fn parse(&self, context: &ParseContext<'_>) -> Result<NormalizedMetadata, String> {
        parse_key_value_text(context.text.ok_or("galleryinfo 不是文字資料")?, true)
    }
}

impl MetadataParser for HDoujinTextParser {
    fn parser_id(&self) -> &'static str {
        "hdoujin_txt"
    }
    fn priority(&self) -> i64 {
        65
    }
    fn probe(&self, context: &ParseContext<'_>) -> u8 {
        let text = context.text.unwrap_or_default().to_ascii_lowercase();
        let signals = ["artist:", "circle:", "parody:", "characters:", "language:"]
            .into_iter()
            .filter(|needle| text.contains(needle))
            .count();
        if signals >= 3 {
            85
        } else if signals >= 2 {
            65
        } else {
            0
        }
    }
    fn parse(&self, context: &ParseContext<'_>) -> Result<NormalizedMetadata, String> {
        parse_key_value_text(context.text.ok_or("HDoujin info.txt 不是文字資料")?, false)
    }
}

impl MetadataParser for EhdlTextParser {
    fn parser_id(&self) -> &'static str {
        "ehdl_txt"
    }
    fn priority(&self) -> i64 {
        55
    }
    fn probe(&self, context: &ParseContext<'_>) -> u8 {
        let text = context.text.unwrap_or_default().to_ascii_lowercase();
        if text.contains("source:") && text.contains("tags:") {
            55
        } else if context
            .source_path
            .to_ascii_lowercase()
            .ends_with("info.txt")
            && text.contains("title:")
        {
            35
        } else {
            0
        }
    }
    fn parse(&self, context: &ParseContext<'_>) -> Result<NormalizedMetadata, String> {
        parse_key_value_text(context.text.ok_or("EHDL info.txt 不是文字資料")?, false)
    }
}

fn parsers() -> Vec<Box<dyn MetadataParser>> {
    vec![
        Box::new(ComicInfoParser),
        Box::new(GalleryDlJsonParser),
        Box::new(HDoujinJsonParser),
        Box::new(HDoujinTextParser),
        Box::new(GalleryInfoParser),
        Box::new(EhdlTextParser),
    ]
}

pub fn parse_metadata_for_path(path: &Path) -> ParseOutcome {
    let mut outcome = ParseOutcome::default();
    if path.is_dir() {
        match std::fs::read_dir(path) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let entry_path = entry.path();
                    if entry_path.is_file()
                        && is_metadata_name(&entry.file_name().to_string_lossy())
                    {
                        parse_artifact(
                            &entry_path.to_string_lossy(),
                            read_bounded(&entry_path),
                            &mut outcome,
                        );
                    }
                }
            }
            Err(error) => outcome.diagnostics.push(diagnostic(
                None,
                path,
                format!("無法列出 metadata 目錄：{error}"),
            )),
        }
    } else if is_zip_path(path) {
        parse_zip_metadata(path, &mut outcome);
        for sibling in json_siblings(path) {
            if sibling.is_file() {
                parse_artifact(
                    &sibling.to_string_lossy(),
                    read_bounded(&sibling),
                    &mut outcome,
                );
            }
        }
    } else {
        for sibling in json_siblings(path) {
            if sibling.is_file() {
                parse_artifact(
                    &sibling.to_string_lossy(),
                    read_bounded(&sibling),
                    &mut outcome,
                );
            }
        }
    }
    outcome.sources.push(filename_source(path));
    outcome
}

pub fn filename_metadata_for_path(path: &Path) -> ParsedMetadataSource {
    filename_source(path)
}

fn parse_zip_metadata(path: &Path, outcome: &mut ParseOutcome) {
    let Ok(file) = File::open(path) else {
        outcome
            .diagnostics
            .push(diagnostic(None, path, "無法開啟壓縮檔"));
        return;
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        outcome.diagnostics.push(diagnostic(
            None,
            path,
            "ZIP 中央目錄損壞或不是支援的 ZIP/CBZ",
        ));
        return;
    };
    let mut targets = Vec::new();
    for index in 0..archive.len() {
        if let Ok(file) = archive.by_index(index) {
            let name = file.name().replace('\\', "/");
            if !name.trim_matches('/').contains('/') && is_metadata_name(&name) {
                targets.push((index, name));
            }
        }
    }
    for (index, name) in targets {
        let result = archive
            .by_index(index)
            .map_err(|error| error.to_string())
            .and_then(|mut entry| {
                if entry.size() as usize > MAX_METADATA_BYTES {
                    return Err(format!(
                        "metadata 超過 {} MiB 安全上限",
                        MAX_METADATA_BYTES / 1024 / 1024
                    ));
                }
                let mut bytes = Vec::with_capacity(entry.size() as usize);
                entry
                    .read_to_end(&mut bytes)
                    .map_err(|error| error.to_string())?;
                Ok(bytes)
            });
        parse_artifact(
            &format!("{}::{name}", path.to_string_lossy()),
            result,
            outcome,
        );
    }
}

fn parse_artifact(source_path: &str, result: Result<Vec<u8>, String>, outcome: &mut ParseOutcome) {
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(message) => {
            outcome.diagnostics.push(ParserDiagnostic {
                parser_id: None,
                source_path: source_path.to_string(),
                severity: "warning".into(),
                message,
            });
            return;
        }
    };
    let needs_text = !source_path.to_ascii_lowercase().ends_with(".json");
    let (decoded, encoding_name, lossy) = if needs_text {
        decode_text(&bytes)
    } else {
        (None, None, false)
    };
    if lossy {
        outcome.diagnostics.push(ParserDiagnostic {
            parser_id: None,
            source_path: source_path.to_string(),
            severity: "warning".into(),
            message: format!(
                "以 {} 容錯解碼；請確認文字是否完整",
                encoding_name.as_deref().unwrap_or("未知編碼")
            ),
        });
    }
    let context = ParseContext {
        source_path,
        bytes: &bytes,
        text: decoded.as_deref(),
    };
    let available = parsers();
    let Some((score, parser)) = available
        .iter()
        .map(|parser| (parser.probe(&context), parser))
        .max_by_key(|(score, _)| *score)
    else {
        return;
    };
    if score == 0 {
        outcome.diagnostics.push(ParserDiagnostic {
            parser_id: None,
            source_path: source_path.to_string(),
            severity: "warning".into(),
            message: "找到 metadata 檔，但沒有 parser 能可靠辨識其格式".into(),
        });
        return;
    }
    match parser.parse(&context) {
        Ok(metadata) => outcome.sources.push(ParsedMetadataSource {
            parser_id: parser.parser_id().into(),
            parser_version: parser.parser_version().into(),
            priority: parser.priority(),
            confidence: f64::from(score) / 100.0,
            source_path: source_path.to_string(),
            source_digest: blake3::hash(&bytes).to_hex().to_string(),
            raw_json: if source_path.to_ascii_lowercase().ends_with(".json") {
                serde_json::from_slice(&bytes).unwrap_or(Value::Null)
            } else {
                json!({"text": decoded.unwrap_or_default(), "encoding": encoding_name})
            },
            metadata,
        }),
        Err(message) => outcome.diagnostics.push(ParserDiagnostic {
            parser_id: Some(parser.parser_id().into()),
            source_path: source_path.to_string(),
            severity: "warning".into(),
            message,
        }),
    }
}

fn parse_json_metadata(bytes: &[u8], hdoujin: bool) -> Result<NormalizedMetadata, String> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|error| format!("JSON 無法解析：{error}"))?;
    let object = value
        .as_object()
        .ok_or("metadata JSON 根節點必須是 object")?;
    let first = |keys: &[&str]| keys.iter().find_map(|key| value_text(object.get(*key)));
    let mut creators = BTreeMap::new();
    for (role, keys) in [
        (
            "artist",
            &["artist", "artists", "author", "authors"] as &[&str],
        ),
        ("group", &["circle", "group"]),
        ("translator", &["translator"]),
    ] {
        let mut values = Vec::new();
        for key in keys {
            values.extend(value_list(object.get(*key)));
        }
        values.sort();
        values.dedup();
        if !values.is_empty() {
            creators.insert(role.into(), values);
        }
    }
    let mut tags = Vec::new();
    collect_json_tags(object.get("tags"), "general", &mut tags);
    for (namespace, key) in [
        ("character", "characters"),
        ("parody", "parody"),
        ("group", "circle"),
        ("artist", "artist"),
    ] {
        collect_json_tags(object.get(key), namespace, &mut tags);
    }
    if hdoujin {
        for artist in creators.get("artist").into_iter().flatten() {
            tags.push(ScopedTag {
                namespace: "artist".into(),
                value: artist.clone(),
            });
        }
    }
    Ok(NormalizedMetadata {
        title: first(&["title", "name"]),
        series: first(&["series", "parody"]),
        volume: first(&["volume"]),
        number: first(&["number", "chapter"]),
        summary: first(&["description", "summary", "caption"]),
        language: first(&["language", "lang"]),
        reading_direction: first(&["reading_direction", "direction"])
            .and_then(|item| normalize_direction(&item)),
        published_at: first(&["date", "published_at", "upload_date"]),
        creators,
        tags: dedupe_tags(tags),
    })
}

fn parse_key_value_text(text: &str, gallery: bool) -> Result<NormalizedMetadata, String> {
    let mut fields: BTreeMap<String, String> = BTreeMap::new();
    let mut current_key: Option<String> = None;
    for raw_line in text.replace('\r', "\n").lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim().to_ascii_lowercase().replace(' ', "_");
            fields
                .entry(key.clone())
                .and_modify(|old| {
                    old.push_str(", ");
                    old.push_str(value.trim());
                })
                .or_insert_with(|| value.trim().to_string());
            current_key = Some(key);
        } else if gallery {
            if let Some(key) = current_key.as_ref() {
                fields.entry(key.clone()).and_modify(|old| {
                    old.push_str(", ");
                    old.push_str(line);
                });
            }
        }
    }
    if fields.is_empty() {
        return Err("文字 metadata 沒有可辨識的 key:value 欄位".into());
    }
    let mut creators = BTreeMap::new();
    for (role, keys) in [
        ("artist", &["artist", "artists", "author"] as &[&str]),
        ("group", &["circle", "group"]),
        ("translator", &["translator"]),
    ] {
        let values = keys
            .iter()
            .flat_map(|key| split_values(fields.get(*key).map(String::as_str)))
            .collect::<Vec<_>>();
        if !values.is_empty() {
            creators.insert(role.into(), values);
        }
    }
    let mut tags = Vec::new();
    for (namespace, keys) in [
        ("general", &["tags", "tag", "genre"] as &[&str]),
        ("character", &["characters", "character"]),
        ("parody", &["parody", "series"]),
        ("group", &["circle", "group"]),
    ] {
        for key in keys {
            add_tags(&mut tags, namespace, fields.get(*key).map(String::as_str));
        }
    }
    Ok(NormalizedMetadata {
        title: take_field(&fields, &["title", "japanese_title"]),
        series: take_field(&fields, &["series", "parody"]),
        volume: take_field(&fields, &["volume"]),
        number: take_field(&fields, &["number", "chapter"]),
        summary: take_field(&fields, &["summary", "description", "uploader_comment"]),
        language: take_field(&fields, &["language"]),
        reading_direction: take_field(&fields, &["reading_direction", "direction"])
            .and_then(|value| normalize_direction(&value)),
        published_at: take_field(&fields, &["date", "published", "posted"]),
        creators,
        tags: dedupe_tags(tags),
    })
}

fn filename_source(path: &Path) -> ParsedMetadataSource {
    filename_metadata_for_discovered_path(path, path.is_dir())
}

/// 由掃描器提供已知類型，避免僅解析檔名卻再次存取外部 Files provider。
pub(crate) fn filename_metadata_for_discovered_path(
    path: &Path,
    is_directory: bool,
) -> ParsedMetadataSource {
    let title = if is_directory {
        path.file_name()
    } else {
        path.file_stem()
    }
    .and_then(|item| item.to_str())
    .unwrap_or("Unknown")
    .trim()
    .to_string();
    let series = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|item| item.to_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string);
    let mut creators = BTreeMap::new();
    if let Some(rest) = title.strip_prefix('[') {
        if let Some((artist, _)) = rest.split_once(']') {
            if !artist.trim().is_empty() {
                creators.insert("artist".into(), vec![artist.trim().to_string()]);
            }
        }
    }
    let raw = json!({"title": title, "series": series});
    ParsedMetadataSource {
        parser_id: "filename".into(),
        parser_version: "1".into(),
        priority: 10,
        confidence: 0.2,
        source_path: path.to_string_lossy().to_string(),
        source_digest: blake3::hash(raw.to_string().as_bytes())
            .to_hex()
            .to_string(),
        raw_json: raw,
        metadata: NormalizedMetadata {
            title: Some(title),
            series,
            creators,
            ..Default::default()
        },
    }
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() as usize > MAX_METADATA_BYTES {
        return Err(format!(
            "metadata 超過 {} MiB 安全上限",
            MAX_METADATA_BYTES / 1024 / 1024
        ));
    }
    std::fs::read(path).map_err(|error| error.to_string())
}

fn decode_text(bytes: &[u8]) -> (Option<String>, Option<String>, bool) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (
            Some(String::from_utf8_lossy(&bytes[3..]).into_owned()),
            Some("UTF-8 BOM".into()),
            false,
        );
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (Some(text.to_string()), Some("UTF-8".into()), false);
    }
    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    let mut encoding = detector.guess(None, true);
    if encoding == UTF_8 {
        encoding = Encoding::for_label(b"gb18030").unwrap_or(UTF_8);
    }
    let (text, _, had_errors) = encoding.decode(bytes);
    (
        Some(text.into_owned()),
        Some(encoding.name().to_string()),
        had_errors,
    )
}

fn json_siblings(path: &Path) -> Vec<PathBuf> {
    let mut paths = vec![path.with_extension("json")];
    if let Some(file_name) = path.file_name().and_then(|item| item.to_str()) {
        paths.push(path.with_file_name(format!("{file_name}.json")));
    }
    paths.sort();
    paths.dedup();
    paths
}

fn is_zip_path(path: &Path) -> bool {
    path.extension()
        .and_then(|item| item.to_str())
        .is_some_and(|item| matches!(item.to_ascii_lowercase().as_str(), "zip" | "cbz"))
}

fn is_metadata_name(name: &str) -> bool {
    matches!(
        name.trim_matches('/').to_ascii_lowercase().as_str(),
        "comicinfo.xml" | "info.json" | "info.txt" | "galleryinfo.txt"
    )
}

fn diagnostic(
    parser_id: Option<&str>,
    path: &Path,
    message: impl Into<String>,
) -> ParserDiagnostic {
    ParserDiagnostic {
        parser_id: parser_id.map(str::to_string),
        source_path: path.to_string_lossy().to_string(),
        severity: "warning".into(),
        message: message.into(),
    }
}

fn clean(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}
fn split_values(value: Option<&str>) -> Vec<String> {
    value
        .into_iter()
        .flat_map(|item| item.split([',', ';', '|', '\n']))
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}
fn add_tags(tags: &mut Vec<ScopedTag>, namespace: &str, value: Option<&str>) {
    tags.extend(
        split_values(value)
            .into_iter()
            .map(|item| parse_scoped_tag(&item, namespace)),
    );
}
fn parse_scoped_tag(value: &str, default_namespace: &str) -> ScopedTag {
    if let Some((namespace, item)) = value.split_once(':') {
        if !namespace.trim().is_empty() && !item.trim().is_empty() {
            return ScopedTag {
                namespace: namespace.trim().to_ascii_lowercase(),
                value: item.trim().to_string(),
            };
        }
    }
    ScopedTag {
        namespace: default_namespace.into(),
        value: value.trim().to_string(),
    }
}
fn dedupe_tags(tags: Vec<ScopedTag>) -> Vec<ScopedTag> {
    tags.into_iter()
        .filter(|tag| !tag.value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
fn value_text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(item)) => clean(Some(item.clone())),
        Some(Value::Number(item)) => Some(item.to_string()),
        _ => None,
    }
}
fn value_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| value_text(Some(item)))
            .collect(),
        Some(value) => value_text(Some(value))
            .map(|item| split_values(Some(&item)))
            .unwrap_or_default(),
        None => vec![],
    }
}
fn collect_json_tags(value: Option<&Value>, namespace: &str, tags: &mut Vec<ScopedTag>) {
    match value {
        Some(Value::Object(groups)) => {
            for (group, values) in groups {
                for item in value_list(Some(values)) {
                    tags.push(parse_scoped_tag(&item, group));
                }
            }
        }
        Some(value) => {
            for item in value_list(Some(value)) {
                tags.push(parse_scoped_tag(&item, namespace));
            }
        }
        None => {}
    }
}
fn take_field(fields: &BTreeMap<String, String>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| fields.get(*key).cloned())
        .and_then(|item| clean(Some(item)))
}
fn normalize_direction(value: &str) -> Option<String> {
    let lower = value.trim().to_ascii_lowercase();
    if lower.contains("righttoleft") || lower == "rtl" || lower == "yesandrighttoleft" {
        Some("rtl".into())
    } else if lower.contains("lefttoright") || lower == "ltr" || lower == "no" {
        Some("ltr".into())
    } else if lower.contains("webtoon") || lower.contains("vertical") {
        Some("vertical".into())
    } else {
        clean(Some(value.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comicinfo_normalizes_creators_and_tags() {
        let xml = r#"<ComicInfo><Title>第一集</Title><Series>星光</Series><Writer>小羊, 小鹿</Writer><Tags>百合, 校園</Tags><LanguageISO>zh-TW</LanguageISO><Manga>YesAndRightToLeft</Manga></ComicInfo>"#;
        let context = ParseContext {
            source_path: "ComicInfo.xml",
            bytes: xml.as_bytes(),
            text: Some(xml),
        };
        let parsed = ComicInfoParser.parse(&context).unwrap();
        assert_eq!(parsed.title.as_deref(), Some("第一集"));
        assert_eq!(parsed.creators["writer"].len(), 2);
        assert_eq!(parsed.reading_direction.as_deref(), Some("rtl"));
        assert!(parsed.tags.iter().any(|tag| tag.value == "百合"));
    }

    #[test]
    fn hdoujin_json_wins_its_shape() {
        let json = r#"{"title":"測試","artist":["作者"],"circle":"社團","characters":["角色"],"tags":["百合"]}"#;
        let bytes = json.as_bytes();
        let context = ParseContext {
            source_path: "info.json",
            bytes,
            text: None,
        };
        assert!(HDoujinJsonParser.probe(&context) > GalleryDlJsonParser.probe(&context));
        let parsed = HDoujinJsonParser.parse(&context).unwrap();
        assert_eq!(parsed.creators["artist"], vec!["作者"]);
    }

    #[test]
    fn txt_without_final_newline_is_supported() {
        let text = "Title: 測試\r\nArtist: 作者\r\nTags: 百合, 校園";
        let parsed = parse_key_value_text(text, false).unwrap();
        assert_eq!(parsed.title.as_deref(), Some("測試"));
        assert_eq!(parsed.tags.len(), 2);
    }

    #[test]
    fn every_supported_sidecar_shape_selects_one_parser() {
        let cases = [
            ("gallery.json", r#"{"title":"作品","category":"manga","_extractor":"example","tags":["百合"]}"#, "gallery_dl"),
            ("info.json", r#"{"title":"作品","artist":"作者","circle":"社團","characters":["角色"],"tags":["百合"]}"#, "hdoujin_json"),
            ("info.txt", "Title: 作品\nArtist: 作者\nCircle: 社團\nParody: 系列\nLanguage: Chinese", "hdoujin_txt"),
            ("galleryinfo.txt", "Title: 作品\nGallery URL: https://example.invalid/1\nTags: 百合\nUploader Comment: 測試", "galleryinfo"),
            ("info.txt", "Title: 作品\nSource: local\nTags: 百合", "ehdl_txt"),
        ];
        for (path, source, expected) in cases {
            let bytes = source.as_bytes();
            let context = ParseContext {
                source_path: path,
                bytes,
                text: if path.ends_with(".json") {
                    None
                } else {
                    Some(source)
                },
            };
            let available = parsers();
            let (_, parser) = available
                .iter()
                .map(|parser| (parser.probe(&context), parser))
                .max_by_key(|(score, _)| *score)
                .unwrap();
            assert_eq!(
                parser.parser_id(),
                expected,
                "unexpected parser for {path}: {source}"
            );
            parser.parse(&context).unwrap();
        }
    }

    #[test]
    fn shift_jis_text_is_decoded_without_panicking() {
        let (encoded, _, _) =
            encoding_rs::SHIFT_JIS.encode("Title: テスト\nArtist: 作者\nTags: 百合");
        let (decoded, encoding, _) = decode_text(&encoded);
        assert!(encoding.is_some());
        assert!(decoded.unwrap().contains("テスト"));
    }
}
