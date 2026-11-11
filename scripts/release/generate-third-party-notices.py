#!/usr/bin/env python3
"""Generate a deterministic, source-backed third-party license bundle."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "src-tauri" / "Cargo.toml"
TARGETS = (
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-apple-ios",
)
OUT_LICENSES = ROOT / "docs/release/THIRD_PARTY_LICENSES.txt"
OUT_MANIFEST = ROOT / "docs/release/third-party-licenses-manifest.json"
LEGAL_BASES = ("license", "licence", "copying", "notice", "copyright", "authors", "unlicense")
LEGAL_TEXT_EXTENSIONS = {"md", "txt", "rst", "html", "htm", "rtf", "spdx", "lib", "lesser"}
SKIP_DIRS = {".git", "target", "node_modules", ".idea", ".vscode", "vendor"}
LEGAL_DIRS = {"license", "licenses", "legal"}
FIRST_PARTY_PACKAGES = {"tauri-plugin-ios-folder"}
SUPPLEMENT_PATH = ROOT / "docs/release/license-source-supplements.json"


class GenerationError(Exception):
    """Expected validation failure with a safe, generator-authored message."""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parse_sqlite_version(header: bytes | None) -> str:
    if header is None:
        raise GenerationError("required SQLite version header is unavailable")
    match = re.search(rb'(?m)^[ \t]*#[ \t]*define[ \t]+SQLITE_VERSION[ \t]+"([0-9]+\.[0-9]+\.[0-9]+)"[ \t]*$', header)
    if match is None:
        raise GenerationError("required SQLite version define is missing or invalid")
    try:
        return match.group(1).decode("ascii")
    except UnicodeError:
        raise GenerationError("required SQLite version define is not ASCII") from None


def immutable_source_url_is_safe(source_url: str, commit: str) -> bool:
    try:
        parsed = urlsplit(source_url)
        return bool(
            parsed.hostname
            and not parsed.username
            and not parsed.password
            and not parsed.query
            and not parsed.fragment
            and commit in source_url
        )
    except ValueError:
        return False


def is_legal_filename(name: str) -> bool:
    lowered = name.casefold()
    for base in LEGAL_BASES:
        if lowered == base:
            return True
        if not any(lowered.startswith(base + delimiter) for delimiter in ("-", "_", ".")):
            continue
        delimiter = lowered[len(base)]
        tail = lowered[len(base) + 1 :]
        if not tail:
            return False
        if delimiter == "." and tail in LEGAL_TEXT_EXTENSIONS:
            return True
        if delimiter == "." and tail in {"mit", "apache", "bsd", "gpl", "lgpl", "mpl", "lesser", "lib", "spdx"}:
            return True
        if "." in tail and tail.rpartition(".")[2] in LEGAL_TEXT_EXTENSIONS:
            return True
        # Common license identifiers such as LICENSE-MIT and LICENSE-APACHE.
        return delimiter in "-_" and all(char.isalnum() or char in "._+-" for char in tail)
    return False


def is_full_license_filename(name: str) -> bool:
    lowered = name.casefold()
    return any(
        lowered == base or any(lowered.startswith(base + delimiter) for delimiter in ("-", "_", "."))
        for base in ("license", "licence", "copying")
    ) and not lowered.endswith(".spdx")


def safe_repository(repository: str | None) -> str | None:
    if not repository:
        return None
    candidate = repository.removeprefix("git+")
    try:
        parsed = urlsplit(candidate)
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        return None
    if parsed.scheme not in {"https", "http", "ssh", "git"} or not host:
        return None
    if port:
        host += f":{port}"
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme, host, path, "", ""))


def package_location(package: dict) -> str:
    try:
        return package_root(package).relative_to(ROOT).as_posix()
    except ValueError:
        return f"{package['name']}@{package['version']} (registry source)"


def readme_license_references(package: dict) -> list[dict[str, str]]:
    root = package_root(package)
    found = []
    try:
        names = sorted(root.iterdir(), key=lambda path: (path.name.casefold(), path.name))
    except OSError:
        return found
    for path in names:
        if not path.name.casefold().startswith("readme") or path.is_symlink() or not path.is_file():
            continue
        try:
            if path.stat().st_size > 1_000_000:
                continue
            contents = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        for match in re.finditer(r"\]\(([^)]+)\)", contents):
            reference = match.group(1).strip()
            if not re.search(r"license|licence|copying", reference, re.IGNORECASE):
                continue
            if "://" in reference:
                reference = safe_repository(reference) or "external license link (sanitized)"
            elif reference.startswith("/") or "\\" in reference:
                reference = "unsafe or absolute license link omitted"
            found.append({"readme": path.name, "reference": reference})
    return found


def load_source_supplements(selected: dict[str, dict], data: dict) -> tuple[list[dict], dict[tuple[str, str], list[dict]], dict[str, bytes]]:
    if data.get("format_version") != 1 or not isinstance(data.get("supplements"), list):
        raise GenerationError("license supplement format is unsupported")
    by_name_version = {(package["name"], package["version"]): package for package in selected.values()}
    normalized = []
    by_package: dict[tuple[str, str], list[dict]] = {}
    texts: dict[str, bytes] = {}
    for item in data["supplements"]:
        text = item.get("text")
        if not isinstance(text, str):
            raise GenerationError("license supplement text is missing")
        raw = text.encode("utf-8")
        if sha256(raw) != item.get("sha256"):
            raise GenerationError("license supplement source hash does not match")
        repository = safe_repository(item.get("repository"))
        source_url = item.get("source_url")
        commit = item.get("commit")
        if not repository or not isinstance(source_url, str) or not commit or commit not in source_url:
            raise GenerationError("license supplement source reference is not immutable")
        if not immutable_source_url_is_safe(source_url, commit):
            raise GenerationError("license supplement URL is not safe to publish")
        source_path = str(item.get("source_path", ""))
        if Path(source_path).is_absolute() or ".." in Path(source_path).parts:
            raise GenerationError("license supplement source path is invalid")
        record = {
            "repository": repository,
            "commit": commit,
            "source_path": source_path,
            "source_url": source_url,
            "git_blob_sha": item.get("git_blob_sha"),
            "sha256": sha256(raw),
            "bytes": len(raw),
            "role": item.get("role", "unspecified-source-text"),
            "notes": item.get("notes", ""),
        }
        texts[record["sha256"]] = raw
        packages = []
        for reference in item.get("packages", []):
            key = (reference.get("name"), reference.get("version"))
            if key not in by_name_version:
                raise GenerationError("license supplement refers to a package outside the selected target graph")
            packages.append({"name": key[0], "version": key[1]})
            by_package.setdefault(key, []).append(record)
        if not packages:
            raise GenerationError("license supplement has no package mapping")
        record["packages"] = packages
        normalized.append(record)
    return normalized, by_package, texts


def load_native_components(data: dict, selected: dict[str, dict]) -> tuple[list[dict], dict[str, bytes]]:
    normalized = []
    texts = {}
    for component in data.get("native_components", []):
        record = {
            "name": component.get("name"),
            "version": component.get("version"),
            "targets": component.get("targets", []),
            "license": component.get("license"),
            "repository": safe_repository(component.get("repository")),
            "commit": component.get("commit"),
            "evidence": component.get("evidence", ""),
            "materials": [],
        }
        if component.get("materials"):
            for material in component["materials"]:
                raw = material.get("text", "").encode("utf-8")
                digest = sha256(raw)
                commit = material.get("commit")
                source_url = material.get("source_url")
                if digest != material.get("sha256") or not commit or not isinstance(source_url, str) or commit not in source_url:
                    raise GenerationError("native component license source hash/reference is invalid")
                if not immutable_source_url_is_safe(source_url, commit):
                    raise GenerationError("native component source URL is not safe to publish")
                source_path = str(material.get("source_path", ""))
                if Path(source_path).is_absolute() or ".." in Path(source_path).parts:
                    raise GenerationError("native component source path is invalid")
                item = {
                    "repository": safe_repository(material.get("repository")),
                    "commit": commit,
                    "source_path": source_path,
                    "source_url": source_url,
                    "git_blob_sha": material.get("git_blob_sha"),
                    "sha256": digest,
                    "bytes": len(raw),
                    "role": material.get("role", "unspecified-source-text"),
                    "notes": material.get("notes", ""),
                }
                record["materials"].append(item)
                texts[digest] = raw
        covered = component.get("covered_by_cargo_package")
        if covered:
            key = (covered.get("name"), covered.get("version"))
            if not any(package.get("name") == key[0] and package.get("version") == key[1] for package in selected.values()):
                raise GenerationError("native component coverage refers to a package outside the selected target graph")
            record["covered_by_cargo_package"] = {"name": key[0], "version": key[1]}
        normalized.append(record)
    return normalized, texts


def manifest_relative_license_file(value: str | None) -> str | None:
    if not value:
        return None
    normalized = value.replace("\\", "/")
    path = Path(normalized)
    if path.is_absolute() or ".." in path.parts:
        return None
    return path.as_posix()


def is_proc_macro(package: dict) -> bool:
    return any("proc-macro" in target.get("crate_types", []) for target in package["targets"])


def cargo_metadata(target: str) -> dict:
    result = subprocess.run(
        [
            "cargo",
            "metadata",
            "--locked",
            "--offline",
            "--format-version",
            "1",
            "--manifest-path",
            str(MANIFEST),
            "--filter-platform",
            target,
        ],
        cwd=ROOT / "src-tauri",
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return json.loads(result.stdout)


def runtime_packages(target: str) -> dict[str, dict]:
    metadata = cargo_metadata(target)
    packages = {package["id"]: package for package in metadata["packages"]}
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    roots = sorted(metadata["workspace_members"])
    reached: set[str] = set()
    stack = list(roots)
    while stack:
        package_id = stack.pop()
        if package_id in reached:
            continue
        reached.add(package_id)
        package = packages[package_id]
        # Proc-macro crates are host-side build tools, even when reached by a
        # normal dependency edge. Their own dependencies are compile-only too.
        if is_proc_macro(package):
            continue
        for dependency in nodes[package_id]["deps"]:
            if any(kind.get("kind") is None for kind in dependency["dep_kinds"]):
                stack.append(dependency["pkg"])
    return {
        package_id: packages[package_id]
        for package_id in reached
        if package_id not in roots and not is_proc_macro(packages[package_id])
    }


def package_root(package: dict) -> Path:
    manifest = Path(package["manifest_path"])
    return manifest.parent


def has_symlink_component(root: Path, relative: str) -> bool:
    current = root
    for part in Path(relative).parts:
        if part in {"", ".", ".."}:
            return True
        current = current / part
        if current.is_symlink():
            return True
    return False


def source_label(package: dict, relative: str) -> str:
    root = package_root(package)
    try:
        repo_relative = root.relative_to(ROOT).as_posix()
        return f"{repo_relative}/{relative}"
    except ValueError:
        source = package.get("source") or "local package"
        kind = "git source" if source.startswith("git+") else "registry source"
        return f"{package['name']}@{package['version']} ({kind})/{relative}"


def safe_legal_files(package: dict) -> list[tuple[str, bytes]]:
    root = package_root(package)
    if root.is_symlink() or not root.is_dir():
        return []
    candidates: set[str] = set()
    explicit = package.get("license_file")
    if explicit:
        candidates.add(explicit.replace("\\", "/"))

    # Search the package's own legal files only. Search known legal folders and
    # libarchive2-sys's bundled upstream tree; do not absorb nested vendored
    # dependencies into a parent crate's attribution.
    for current, dirs, names in os.walk(root, followlinks=False):
        current_path = Path(current)
        depth = len(current_path.relative_to(root).parts)
        dirs[:] = sorted(
            name
            for name in dirs
            if name.casefold() not in SKIP_DIRS
            and not (current_path / name).is_symlink()
            and (
                depth == 0 and name.casefold() in LEGAL_DIRS
                or package["name"] == "libarchive2-sys" and depth == 0 and name == "libarchive"
                or depth > 0 and current_path.parts[-1].casefold() in LEGAL_DIRS
            )
        )
        for name in names:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            if is_legal_filename(name) and not path.is_symlink():
                candidates.add(relative)

    found: list[tuple[str, bytes]] = []
    for relative in sorted(candidates, key=lambda value: (value.casefold(), value)):
        path = root / relative
        try:
            # Resolve each candidate only to verify it stays inside the package.
            if has_symlink_component(root, relative) or not path.resolve(strict=True).is_relative_to(root.resolve(strict=True)):
                continue
            if not path.is_file() or path.stat().st_size > 2_000_000:
                continue
            data = path.read_bytes()
            data.decode("utf-8")
            found.append((relative, data))
        except (OSError, UnicodeError, RuntimeError):
            continue
    return found


def is_license_text_source(relative: str) -> bool:
    return is_full_license_filename(Path(relative).name)


def safe_package_file(package: dict, relative: str) -> bytes | None:
    root = package_root(package)
    path = root / relative
    try:
        if root.is_symlink() or has_symlink_component(root, relative) or not path.resolve(strict=True).is_relative_to(root.resolve(strict=True)):
            return None
        if not path.is_file() or path.stat().st_size > 20_000_000:
            return None
        return path.read_bytes()
    except (OSError, RuntimeError):
        return None


def embedded_sqlite_notice_comments(data: bytes, source_name: str) -> list[tuple[str, bytes]]:
    if source_name == "sqlite3.c":
        markers = list(re.finditer(rb"/\*+ Begin file ([^*\r\n]+?)\s*\*+/", data))
        segments = []
        for index, marker in enumerate(markers):
            end = markers[index + 1].start() if index + 1 < len(markers) else len(data)
            segments.append((marker.group(1).decode("ascii", "replace").strip(), data[marker.end() : end]))
    else:
        segments = [(source_name, data)]
    found = []
    for component, segment in segments:
        for match in re.finditer(rb"/\*.*?\*/", segment, re.DOTALL):
            comment = match.group(0)
            lower = comment.lower()
            if b"author disclaims copyright to this source code" not in lower and b"public domain" not in lower:
                continue
            try:
                comment.decode("utf-8")
            except UnicodeError:
                continue
            found.append((component, comment))
    return found


def main() -> int:
    runtime_graph_packages: dict[str, dict] = {}
    target_ids: dict[str, list[str]] = {}
    for target in TARGETS:
        selected = runtime_packages(target)
        target_ids[target] = sorted(selected)
        runtime_graph_packages.update(selected)
    first_party = {
        package_id: package
        for package_id, package in runtime_graph_packages.items()
        if package["name"] in FIRST_PARTY_PACKAGES
    }
    all_packages = {
        package_id: package
        for package_id, package in runtime_graph_packages.items()
        if package_id not in first_party
    }

    lock_path = ROOT / "src-tauri" / "Cargo.lock"
    lock_hash = sha256(lock_path.read_bytes())
    try:
        supplement_data = json.loads(SUPPLEMENT_PATH.read_text(encoding="utf-8")) if SUPPLEMENT_PATH.is_file() else {"format_version": 1, "supplements": [], "native_components": []}
    except json.JSONDecodeError:
        raise GenerationError("license source supplements JSON is invalid") from None
    supplement_hash = sha256(SUPPLEMENT_PATH.read_bytes()) if SUPPLEMENT_PATH.is_file() else None
    source_supplements, supplements_by_package, supplement_texts = load_source_supplements(all_packages, supplement_data)
    native_components, native_texts = load_native_components(supplement_data, all_packages)
    shared_texts: dict[str, tuple[bytes, list[str]]] = {}
    for record in source_supplements:
        package_labels = ", ".join(f"{package['name']}@{package['version']}" for package in record["packages"])
        label = f"{record['source_url']} [packages: {package_labels}; role: {record['role']}]"
        shared_texts.setdefault(record["sha256"], (supplement_texts[record["sha256"]], []))[1].append(label)
    for component in native_components:
        for material in component["materials"]:
            label = f"{material['source_url']} [{component['name']} {component['version']}; role: {material['role']}]"
            shared_texts.setdefault(material["sha256"], (native_texts[material["sha256"]], []))[1].append(label)
    package_records = []
    gaps = []
    sqlite_sources = []
    sqlite_package = next((p for p in all_packages.values() if p["name"] == "libsqlite3-sys"), None)
    if sqlite_package is None:
        raise GenerationError("expected bundled SQLite package is missing")
    sqlite_notices = []
    sqlite_notice_components: set[str] = set()
    sqlite_header = None
    for relative in ("sqlite3/sqlite3.c", "sqlite3/sqlite3.h", "sqlite3/sqlite3ext.h"):
        data = safe_package_file(sqlite_package, relative)
        if data is None:
            if relative == "sqlite3/sqlite3.h":
                raise GenerationError("required SQLite version header is unavailable")
            sqlite_sources.append({"source": source_label(sqlite_package, relative), "coverage": "source-unreadable"})
            continue
        if relative == "sqlite3/sqlite3.h":
            sqlite_header = data
        source = source_label(sqlite_package, relative)
        sqlite_sources.append({"source": source, "sha256": sha256(data), "bytes": len(data)})
        for component, excerpt in embedded_sqlite_notice_comments(data, Path(relative).name):
            digest = sha256(excerpt)
            notice_source = source + f" (embedded component {component})"
            shared_texts.setdefault(digest, (excerpt, []))[1].append(notice_source)
            sqlite_notice_components.add(component)
            sqlite_notices.append({"source": source, "component": component, "sha256": digest, "bytes": len(excerpt)})
    sqlite_version = parse_sqlite_version(sqlite_header)

    repository_counts: dict[str, int] = {}
    for package in all_packages.values():
        repository = safe_repository(package.get("repository"))
        if repository:
            repository_counts[repository] = repository_counts.get(repository, 0) + 1

    for package_id in sorted(all_packages, key=lambda item: (all_packages[item]["name"].casefold(), all_packages[item]["version"], item)):
        package = all_packages[package_id]
        files = safe_legal_files(package)
        readme_refs = readme_license_references(package)
        file_records = []
        for relative, data in files:
            digest = sha256(data)
            label = source_label(package, relative)
            file_records.append({"source": label, "sha256": digest, "bytes": len(data)})
            if digest not in shared_texts:
                shared_texts[digest] = (data, [])
            shared_texts[digest][1].append(label)
        key = (package["name"], package["version"])
        package_supplements = supplements_by_package.get(key, [])
        has_package_license_text = any(is_license_text_source(relative) for relative, _ in files)
        has_original_supplement = any(item["role"] == "original-license-text" for item in package_supplements)
        has_reference_text = any(item["role"] == "canonical-license-reference" for item in package_supplements)
        has_template_attribution_note = any(
            item["role"] == "canonical-license-reference" and "placeholder" in item["notes"].casefold()
            for item in package_supplements
        )
        has_complete_reference = has_reference_text
        has_license_text = has_package_license_text or has_original_supplement or has_complete_reference
        if not has_license_text:
            repository = safe_repository(package.get("repository"))
            category = (
                "shared-official-repository-root-license-source-needed"
                if readme_refs and any(reference["reference"].startswith("..") for reference in readme_refs)
                or repository and repository_counts.get(repository, 0) > 1
                else "official-repository-license-source-needed" if repository
                else "crate-license-source-unavailable"
            )
            gaps.append({
                "name": package["name"],
                "version": package["version"],
                "license": package.get("license"),
                "repository": repository,
                "manifest_relative_source": package_location(package),
                "manifest_relative_license_file": manifest_relative_license_file(package.get("license_file")),
                "existing_candidates": readme_refs,
                "category": category,
                "supplement_sources": [
                    {field: value for field, value in item.items() if field != "packages"}
                    for item in package_supplements
                ],
                "reason": (
                    "No readable UTF-8 LICENSE/LICENCE/COPYING text source found at the package root or in a recognized legal directory; attribution-only files are preserved but do not replace the license text."
                    if file_records else
                    "No readable UTF-8 LICENSE/COPYING/NOTICE/COPYRIGHT/AUTHORS source found at the package root or in a recognized legal directory; original text not fabricated."
                ),
            })
        package_records.append({
            "name": package["name"],
            "version": package["version"],
            "targets": [target for target in TARGETS if package_id in target_ids[target]],
            "license": package.get("license"),
            "license_file": manifest_relative_license_file(package.get("license_file")),
            "repository": safe_repository(package.get("repository")),
            "manifest_relative_source": package_location(package),
            "readme_license_references": readme_refs,
            "source": (
                "workspace path package" if not package.get("source")
                else "git source" if package["source"].startswith("git+")
                else "registry source"
            ),
            "license_files": file_records,
            "supplemental_sources": [
                {field: value for field, value in item.items() if field != "packages"}
                for item in package_supplements
            ],
            "supplemental_notices": sqlite_notices if package["name"] == "libsqlite3-sys" else [],
            "source_coverage_notes": [
                "The upstream declaration has no package-specific copyright holder line. The canonical MIT template has generic placeholders and is a license reference, not a claim of ownership; no attribution is invented."
            ] if has_template_attribution_note else [],
            "text_coverage": (
                "package-original-license-files" if has_package_license_text
                else "official-original-license-text-supplement" if has_original_supplement
                else "upstream-declaration-plus-canonical-license-reference" if has_complete_reference and any(item["role"] == "original-license-declaration" for item in package_supplements)
                else "canonical-license-reference" if has_complete_reference
                else "gap-license-text-source-missing"
            ),
        })

    lines = [
        "G.A.I third-party license texts",
        "",
        "Generated from the Cargo normal runtime dependency union for the targets recorded in",
        "third-party-licenses-manifest.json. Readable package license/notice files, immutable",
        "source supplements, and selected embedded SQLite notice comments are reproduced",
        "verbatim. Source URLs and SHA-256 hashes are in that manifest. Unresolved coverage",
        "gaps are listed there; no source text or attribution is invented.",
        "",
        "Package declarations and source files",
        "===============================",
    ]
    license_chunks: list[bytes] = []
    for package in package_records:
        lines.extend([
            "",
            f"{package['name']} {package['version']} — SPDX: {package['license'] or 'not declared'}",
            f"Source: {package['source']} ({package['manifest_relative_source']})",
        ])
        if package["repository"]:
            lines.append(f"Repository: {package['repository']}")
        if package["license_file"]:
            lines.append(f"Cargo license_file: {package['license_file']}")
        if package["license_files"]:
            for item in package["license_files"]:
                lines.append(f"  {item['source']} (SHA-256 {item['sha256']}; text below)")
        for item in package["supplemental_sources"]:
            lines.append(
                f"  Supplemental source: {item['source_url']} "
                f"(role {item['role']}; SHA-256 {item['sha256']}; text below)"
            )
            if item["notes"]:
                lines.append(f"  Source note: {item['notes']}")
        for note in package["source_coverage_notes"]:
            lines.append(f"  Source coverage note: {note}")
        for item in package["supplemental_notices"]:
            lines.append(
                f"  Embedded source notice excerpt: {item['source']} "
                f"(SHA-256 {item['sha256']}; text below)"
            )
        if package["text_coverage"] == "gap-license-text-source-missing":
            lines.append("  GAP: complete license text source unavailable; see manifest.")
    lines.extend(["", "Native Apple runtime components", "==============================="])
    for component in native_components:
        target_text = ", ".join(component["targets"])
        lines.extend([
            "",
            f"{component['name']} {component['version']} — SPDX: {component['license']}",
            f"Targets: {target_text}",
        ])
        if component["repository"]:
            lines.append(f"Repository: {component['repository']} @ {component['commit']}")
        if component.get("covered_by_cargo_package"):
            covered = component["covered_by_cargo_package"]
            lines.append(f"License texts covered by Cargo package: {covered['name']} {covered['version']}")
        lines.append(f"Evidence: {component['evidence']}")
        for material in component["materials"]:
            lines.append(
                f"  {material['source_url']} (role {material['role']}; "
                f"SHA-256 {material['sha256']}; text below)"
            )
    sqlite_public_domain_components = sorted({
        item["component"] for item in sqlite_notices
        if b"public domain" in shared_texts[item["sha256"]][0].lower()
    })
    lines.extend([
        "",
        "SQLite embedded C notice scan",
        "==============================",
        f"Bundled libsqlite3-sys source hashes and extracted notice comments are recorded in the manifest. Explicit public-domain component comments: {', '.join(sqlite_public_domain_components) or 'none found'}.",
        "The scan includes source comments that explicitly disclaim copyright or state public-domain status; generic API/VFS mentions of third parties are not treated as license notices.",
        "",
        "Original source texts",
        "=====================",
    ])
    for digest in sorted(shared_texts):
        data, sources = shared_texts[digest]
        lines.extend(["", f"SHA-256: {digest}", "Source files:"])
        lines.extend(f"  {source}" for source in sorted(set(sources), key=lambda value: (value.casefold(), value)))
        lines.append("--- BEGIN ORIGINAL FILE ---")
        prefix = ("\n".join(lines) + "\n").encode("utf-8")
        lines = []
        # Keep source bytes, including its final newline count, unchanged.
        license_chunks.append(prefix)
        license_chunks.append(data)
        if not data.endswith(b"\n"):
            license_chunks.append(b"\n")
        license_chunks.append(b"--- END ORIGINAL FILE ---\n")
    if lines:
        license_chunks.append(("\n".join(lines) + "\n").encode("utf-8"))
    license_output = b"".join(license_chunks)

    manifest = {
        "format_version": 1,
        "generator": "scripts/release/generate-third-party-notices.py",
        "input": {
            "cargo_lock": "src-tauri/Cargo.lock",
            "sha256": lock_hash,
            "license_source_supplements": "docs/release/license-source-supplements.json" if supplement_hash else None,
            "license_source_supplements_sha256": supplement_hash,
        },
        "targets": list(TARGETS),
        "target_runtime_package_counts": {target: len(ids) for target, ids in target_ids.items()},
        "target_third_party_package_counts": {
            target: sum(1 for package_id in ids if package_id in all_packages)
            for target, ids in target_ids.items()
        },
        "selection": "Cargo metadata normal dependency edges; proc-macro crates and their compile-time dependencies, build edges, and dev edges excluded. Workspace root is traversed as the graph entry point but is not listed as a third-party package.",
        "package_count": len(package_records),
        "first_party_excluded": [
            {
                "name": package["name"],
                "version": package["version"],
                "targets": [target for target in TARGETS if package_id in target_ids[target]],
                "license": package.get("license"),
                "repository": safe_repository(package.get("repository")),
                "manifest_relative_source": package_location(package),
                "reason": "Known first-party app plugin; excluded from third-party license gaps. Its iOS SwiftRs dependency is separately recorded under native_components.",
            }
            for package_id, package in sorted(first_party.items(), key=lambda item: item[1]["name"])
        ],
        "packages": package_records,
        "supplements": source_supplements,
        "native_components": native_components,
        "sqlite_bundled_c_sources": sqlite_sources,
        "sqlite_bundled_c_notice_review": {
            "version": sqlite_version,
            "notice_comment_count": len(sqlite_notices),
            "distinct_notice_text_count": len({item["sha256"] for item in sqlite_notices}),
            "components_with_notice_comments": len(sqlite_notice_components),
            "public_domain_components": sqlite_public_domain_components,
            "third_party_keyword_mentions_are_not_treated_as_license_text": True,
            "coverage": "Exact embedded comments explicitly disclaiming copyright or stating public-domain status are included; complete SQLite source/header hashes are recorded. No separate SQLite third-party license file is present in libsqlite3-sys. Generic third-party VFS/API references are not license notices.",
        },
        "gap_count": len(gaps),
        "gaps": gaps,
    }
    manifest_output = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    OUT_LICENSES.write_bytes(license_output)
    OUT_MANIFEST.write_bytes(manifest_output)
    print(json.dumps({
        "packages": len(package_records),
        "gaps": len(gaps),
        "license_bytes": len(license_output),
        "manifest_bytes": len(manifest_output),
        "lock_sha256": lock_hash,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GenerationError as error:
        print(f"generation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
    except subprocess.CalledProcessError as error:
        print(f"generation failed: cargo metadata exited with code {error.returncode}", file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        # Do not print third-party exception messages, input values, or paths.
        print(f"generation failed: unexpected {type(error).__name__}", file=sys.stderr)
        raise SystemExit(1)
