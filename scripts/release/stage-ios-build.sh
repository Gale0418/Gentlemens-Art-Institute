#!/bin/bash
# 將建置必要輸入複製到本機磁碟；不攜帶漫畫庫、帳密或既有編譯產物。
set -euo pipefail
source_root="$(cd "$(dirname "$0")/../.." && pwd)"
command -v rsync >/dev/null

fail_stage() {
  echo "iOS staging failed: $1" >&2
  exit 4
}

cargo_field() {
  local section="$1"
  local manifest="$2"
  awk -v wanted_section="$section" '
    $0 == wanted_section { in_section = 1; next }
    /^\[/ { in_section = 0 }
    in_section && $1 == "name" && $2 == "=" {
      gsub(/"/, "", $3)
      print $3
      exit
    }
  ' "$manifest"
}

migrate_staged_apple_project() {
  local stage_root="$1"
  local apple_root="$stage_root/src-tauri/gen/apple"
  local project_yml="$apple_root/project.yml"
  local cargo_manifest="$stage_root/src-tauri/Cargo.toml"
  local package_name lib_name project_name backup_root

  [[ -f "$project_yml" ]] || return 0
  [[ -f "$cargo_manifest" ]] || fail_stage "staged Cargo.toml is missing"

  package_name="$(cargo_field '[package]' "$cargo_manifest")"
  lib_name="$(cargo_field '[lib]' "$cargo_manifest")"
  project_name="$(sed -n 's/^name:[[:space:]]*//p' "$project_yml" | head -n 1 | tr -d '"[:space:]')"
  [[ -n "$package_name" ]] || fail_stage "cannot read [package].name from staged Cargo.toml"
  [[ -n "$lib_name" ]] || fail_stage "cannot read [lib].name from staged Cargo.toml"
  [[ -n "$project_name" ]] || fail_stage "cannot read generated Apple project name"
  [[ "$package_name" == "gai" && "$lib_name" == "gai_lib" ]] || \
    fail_stage "unexpected Cargo identity: package=$package_name lib=$lib_name"

  if [[ "$project_name" == "$package_name" ]]; then
    return 0
  fi

  # This repository's known stale generated identity is app -> gai. Refuse
  # to guess at unrelated generated projects or silently rewrite their paths.
  [[ "$package_name" == "gai" && "$project_name" == "app" ]] || \
    fail_stage "unsupported generated Apple project identity: $project_name -> $package_name"
  [[ -d "$apple_root/app_iOS" ]] || fail_stage "stale app_iOS directory is missing"
  [[ -d "$apple_root/app.xcodeproj" ]] || fail_stage "stale app.xcodeproj is missing"
  [[ -d "$apple_root/Sources/app" ]] || fail_stage "stale Sources/app directory is missing"
  [[ -f "$apple_root/app_iOS/app_iOS.entitlements" ]] || \
    fail_stage "stale app_iOS entitlements are missing"
  command -v xcodegen >/dev/null || fail_stage "xcodegen is required to regenerate the staged Apple project"

  backup_root="$stage_root/.gai-stage-backup/gen-apple-before-package-name-migration"
  mkdir -p "$(dirname "$backup_root")"
  cp -a "$apple_root" "$backup_root"

  mv "$apple_root/app.xcodeproj" "$apple_root/gai.xcodeproj"
  mv "$apple_root/app_iOS" "$apple_root/gai_iOS"
  mv "$apple_root/Sources/app" "$apple_root/Sources/gai"
  mv "$apple_root/gai_iOS/app_iOS.entitlements" "$apple_root/gai_iOS/gai_iOS.entitlements"

  perl -0pi -e 's/^name:[[:space:]]*"?app"?[[:space:]]*$/name: gai/m; s/\bapp_iOS\b/gai_iOS/g' "$project_yml"
  xcodegen generate --spec "$project_yml" --project "$apple_root" --quiet

  [[ -d "$apple_root/gai.xcodeproj" ]] || fail_stage "xcodegen did not create gai.xcodeproj"
  [[ -f "$project_yml" ]] || fail_stage "migrated project.yml is missing"
  grep -q '^name: gai[[:space:]]*$' "$project_yml" || fail_stage "migrated project.yml still has the stale name"
  grep -q 'path: gai_iOS/Info.plist' "$project_yml" || fail_stage "migrated project.yml lost the iOS Info.plist path"
  grep -q 'path: gai_iOS/gai_iOS.entitlements' "$project_yml" || \
    fail_stage "migrated project.yml lost the iOS entitlements path"
  grep -q 'package: tauri-plugin-ios-folder' "$project_yml" || \
    fail_stage "migrated project.yml lost the native plugin dependency"
  echo "Migrated staged Apple project app -> gai; backup: $backup_root" >&2
}

# 六 GiB 是最低起跑門檻，實際 archive 仍可能需要更多空間。
free_kib="$(df -Pk "${TMPDIR:-/tmp}" | awk 'NR == 2 { print $4 }')"
if [[ ! "$free_kib" =~ ^[0-9]+$ ]] || (( free_kib < 6 * 1024 * 1024 )); then
  echo "本機暫存磁碟可用空間不足 6 GiB，未建立建置副本。" >&2
  exit 3
fi
stage_root="$(mktemp -d "${TMPDIR:-/tmp}/gai-ios-stage.XXXXXX")"
for entry in public src-tauri scripts package.json package-lock.json rust-toolchain.toml; do
  rsync -a --exclude='.cargo/' --exclude='target/' --exclude='.build/' --exclude='gen/apple/build/' \
    --exclude='gen/apple/Externals/' --exclude='gen/apple/assets/' \
    "$source_root/$entry" "$stage_root/"
done
# 不複製 SMB 上的 node_modules：其 .bin symlink 可能已變成一般檔案。
# 呼叫端進入副本後以 npm ci --ignore-scripts 依 lockfile 安裝建置依賴。
mkdir -p "$stage_root/src-tauri/gen/apple/Externals" "$stage_root/src-tauri/gen/apple/assets"
migrate_staged_apple_project "$stage_root"
printf '%s\n' "$stage_root"
