#!/bin/bash
# 將建置必要輸入複製到本機磁碟；不攜帶漫畫庫、帳密或既有編譯產物。
set -euo pipefail
source_root="$(cd "$(dirname "$0")/../.." && pwd)"
command -v rsync >/dev/null

fail_stage() {
  echo "iOS staging failed: $1" >&2
  local had_metadata_transaction="$metadata_transaction_active"
  rollback_staged_ios_metadata_transaction
  if [[ "$had_metadata_transaction" == 1 || -n "$metadata_transaction_previous_exit_trap" ]]; then
    restore_staged_ios_metadata_exit_trap
  fi
  exit 4
}

metadata_transaction_active=0
metadata_transaction_backup=""
metadata_transaction_tmp_parent=""
metadata_transaction_previous_exit_trap=""
metadata_transaction_previous_hup_trap=""
metadata_transaction_previous_int_trap=""
metadata_transaction_previous_term_trap=""
metadata_transaction_originals=()
metadata_transaction_backups=()

cleanup_staged_ios_metadata_transaction() {
  if [[ -n "$metadata_transaction_backup" && -d "$metadata_transaction_backup" &&
    "$metadata_transaction_backup" == "$metadata_transaction_tmp_parent"/gai-ios-metadata-transaction.* ]]; then
    rm -rf -- "$metadata_transaction_backup"
  fi
  metadata_transaction_backup=""
  metadata_transaction_tmp_parent=""
  metadata_transaction_originals=()
  metadata_transaction_backups=()
}

rollback_staged_ios_metadata_transaction() {
  local index rollback_failed=0
  if (( metadata_transaction_active != 1 )); then
    cleanup_staged_ios_metadata_transaction
    return 0
  fi
  metadata_transaction_active=0
  for (( index = ${#metadata_transaction_originals[@]} - 1; index >= 0; index-- )); do
    if [[ -L "${metadata_transaction_originals[index]}" ]] ||
      ! cp -p -- "${metadata_transaction_backups[index]}" "${metadata_transaction_originals[index]}"; then
      rollback_failed=1
      echo "iOS staging rollback failed for ${metadata_transaction_originals[index]}" >&2
    fi
  done
  cleanup_staged_ios_metadata_transaction
  if (( rollback_failed == 1 )); then
    echo "iOS staging rollback was incomplete; inspect the affected staged metadata files." >&2
  fi
}

metadata_transaction_exit_handler() {
  local status="$?"
  rollback_staged_ios_metadata_transaction
  if [[ "$metadata_transaction_previous_exit_trap" == *cleanup_stage_on_exit* ]]; then
    metadata_transaction_previous_exit_trap=""
    trap - EXIT
    restore_staged_ios_metadata_signal_traps
    cleanup_stage_on_exit "$status"
  fi
  restore_staged_ios_metadata_exit_trap
  exit "$status"
}

restore_staged_ios_metadata_signal_traps() {
  if [[ -n "$metadata_transaction_previous_hup_trap" ]]; then
    eval "$metadata_transaction_previous_hup_trap"
  else
    trap - HUP
  fi
  if [[ -n "$metadata_transaction_previous_int_trap" ]]; then
    eval "$metadata_transaction_previous_int_trap"
  else
    trap - INT
  fi
  if [[ -n "$metadata_transaction_previous_term_trap" ]]; then
    eval "$metadata_transaction_previous_term_trap"
  else
    trap - TERM
  fi
  metadata_transaction_previous_hup_trap=""
  metadata_transaction_previous_int_trap=""
  metadata_transaction_previous_term_trap=""
}

restore_staged_ios_metadata_exit_trap() {
  if [[ -n "$metadata_transaction_previous_exit_trap" ]]; then
    eval "$metadata_transaction_previous_exit_trap"
  else
    trap - EXIT
  fi
  metadata_transaction_previous_exit_trap=""
  restore_staged_ios_metadata_signal_traps
}

begin_staged_ios_metadata_transaction() {
  local transaction_parent="$1"
  metadata_transaction_tmp_parent="$transaction_parent"
  metadata_transaction_active=0
  metadata_transaction_originals=()
  metadata_transaction_backups=()
  metadata_transaction_previous_exit_trap="$(trap -p EXIT)"
  metadata_transaction_previous_hup_trap="$(trap -p HUP)"
  metadata_transaction_previous_int_trap="$(trap -p INT)"
  metadata_transaction_previous_term_trap="$(trap -p TERM)"
  trap metadata_transaction_exit_handler EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  metadata_transaction_backup="$(mktemp -d "$transaction_parent/gai-ios-metadata-transaction.XXXXXX")" || \
    fail_stage "cannot create a private iOS metadata transaction directory"
  metadata_transaction_active=1
}

backup_staged_ios_metadata_file() {
  local original="$1"
  local label="$2"
  local backup="$metadata_transaction_backup/$label"
  [[ ! -L "$original" ]] || fail_stage "staged iOS metadata file must not be a symbolic link: $original"
  [[ -f "$original" ]] || fail_stage "staged iOS metadata file is missing: $original"
  cp -p -- "$original" "$backup" || fail_stage "cannot back up staged iOS metadata file: $original"
  metadata_transaction_originals+=("$original")
  metadata_transaction_backups+=("$backup")
}

commit_staged_ios_metadata_transaction() {
  metadata_transaction_active=0
  cleanup_staged_ios_metadata_transaction
  restore_staged_ios_metadata_exit_trap
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

validate_staged_apple_project() {
  local stage_root="$1"
  local apple_root="$stage_root/src-tauri/gen/apple"
  local project_yml="$apple_root/project.yml"
  local project_name project_file
  [[ -f "$project_yml" ]] || fail_stage "staged project.yml is missing"

  # Externals contains the Rust archive consumed by the Frameworks phase. It
  # must never be declared as a source/resource directory: XcodeGen would
  # otherwise copy libapp.a into the application bundle as a standalone file,
  # which App Store validation rejects as invalid bundle structure.
  if grep -Eq '^[[:space:]]*-[[:space:]]+path:[[:space:]]+Externals[[:space:]]*$' "$project_yml"; then
    fail_stage "staged project.yml must not add Externals to application sources/resources; libapp.a is a linked archive"
  fi

  project_name="$(sed -n 's/^name:[[:space:]]*//p' "$project_yml" | head -n 1 | tr -d '"[:space:]')"
  [[ -n "$project_name" ]] || fail_stage "cannot read generated Apple project name"
  project_file="$apple_root/$project_name.xcodeproj/project.pbxproj"
  if [[ -f "$project_file" ]] && grep -Eq '/\* libapp\.a in Resources \*/' "$project_file"; then
    fail_stage "generated Apple project places libapp.a in Resources; refusing to package a standalone library"
  fi
}

sync_staged_ios_plist() {
  local plist="$1"
  local key type canonical_type canonical_value canonical_json existing_type
  local canonical_plist="${CANONICAL_IOS_PLIST_OVERRIDE:-$source_root/src-tauri/gen/apple/app_iOS/Info.plist}"
  [[ -f "$canonical_plist" ]] || fail_stage "trusted canonical iOS Info.plist is missing: $canonical_plist (set CANONICAL_IOS_PLIST_OVERRIDE when staging from a migrated copy)"
  [[ -f "$plist" ]] || fail_stage "staged iOS Info.plist is missing: $plist"
  for key in CFBundleLocalizations ITSAppUsesNonExemptEncryption NSCameraUsageDescription NSPhotoLibraryUsageDescription NSLocalNetworkUsageDescription LSSupportsOpeningDocumentsInPlace UIFileSharingEnabled; do
    canonical_type="$(/usr/bin/plutil -type "$key" -- "$canonical_plist")" || fail_stage "canonical iOS Info.plist is missing $key"
    case "$canonical_type" in
      string|bool|array) ;;
      *) fail_stage "unsupported canonical iOS Info.plist type $canonical_type for $key" ;;
    esac
    if /usr/bin/plutil -type "$key" -- "$plist" >/dev/null 2>&1; then
      existing_type="$(/usr/bin/plutil -type "$key" -- "$plist")" || fail_stage "cannot read staged iOS Info.plist type for $key"
      if [[ "$existing_type" != "$canonical_type" ]]; then
        fail_stage "staged iOS Info.plist $plist has type $existing_type for $key, but trusted canonical has type $canonical_type; refusing to overwrite the existing value"
      fi
      continue
    fi
    type="$canonical_type"
    if [[ "$canonical_type" == "array" ]]; then
      canonical_json="$(/usr/bin/plutil -extract "$key" json -o - -- "$canonical_plist")" || \
        fail_stage "cannot read canonical iOS Info.plist array $key"
      /usr/bin/plutil -insert "$key" -json "$canonical_json" -- "$plist" || \
        fail_stage "cannot insert canonical iOS Info.plist array $key"
    else
      canonical_value="$(/usr/bin/plutil -extract "$key" raw -o - -- "$canonical_plist")" || \
        fail_stage "cannot read canonical iOS Info.plist value $key"
      /usr/bin/plutil -insert "$key" "-$type" "$canonical_value" -- "$plist" || \
        fail_stage "cannot insert canonical iOS Info.plist value $key"
    fi
    /usr/bin/plutil -type "$key" -- "$plist" >/dev/null || fail_stage "inserted iOS Info.plist value $key is missing"
  done
}

project_property_json() {
  local project_dump="$1"
  local target="$2"
  local key="$3"
  printf '%s' "$project_dump" | node -e '
    const fs = require("fs");
    const [target, key] = process.argv.slice(1);
    const spec = JSON.parse(fs.readFileSync(0, "utf8"));
    const properties = spec.targets?.[target]?.info?.properties;
    if (!properties || !Object.hasOwn(properties, key)) process.exit(1);
    process.stdout.write(JSON.stringify(properties[key]));
  ' "$target" "$key"
}

plist_value_json() {
  local plist="$1"
  local key="$2"
  local type value
  type="$(/usr/bin/plutil -type "$key" -- "$plist")" || return 1
  case "$type" in
    array)
      /usr/bin/plutil -extract "$key" json -o - -- "$plist"
      ;;
    string)
      value="$(/usr/bin/plutil -extract "$key" raw -o - -- "$plist")" || return 1
      node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$value"
      ;;
    bool)
      value="$(/usr/bin/plutil -extract "$key" raw -o - -- "$plist")" || return 1
      case "$value" in
        true|false) printf '%s' "$value" ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

sync_staged_project_yml_properties() {
  local project_yml="$1"
  local target="$2"
  local plist="$3"
  local project_root="$(dirname "$project_yml")"
  local project_dump
  local missing=""
  local key property_type property_value plist_value_json project_value_json
  local tmp="${project_yml}.tmp.$$"
  local plist_keys
  command -v xcodegen >/dev/null || fail_stage "xcodegen is required to validate staged project.yml metadata"
  project_dump="$(xcodegen dump --type json --no-env --spec "$project_yml" --project-root "$project_root")" || \
    fail_stage "cannot parse staged project.yml metadata for $target"

  for key in CFBundleLocalizations ITSAppUsesNonExemptEncryption NSCameraUsageDescription NSPhotoLibraryUsageDescription NSLocalNetworkUsageDescription LSSupportsOpeningDocumentsInPlace UIFileSharingEnabled; do
    if project_value_json="$(project_property_json "$project_dump" "$target" "$key")"; then
      plist_value_json="$(plist_value_json "$plist" "$key")" || \
        fail_stage "staged iOS Info.plist is missing $key while project.yml contains it for $target"
      if ! node -e '
        const [projectValue, plistValue] = process.argv.slice(1);
        if (JSON.stringify(JSON.parse(projectValue)) !== JSON.stringify(JSON.parse(plistValue))) process.exit(1);
      ' "$project_value_json" "$plist_value_json"; then
        fail_stage "staged project.yml target $target property $key conflicts with the staged iOS Info.plist; refusing to let xcodegen overwrite an existing value"
      fi
    fi
  done

  plist_keys="$(/usr/bin/plutil -convert json -o - -- "$plist" | node -e 'const fs=require("fs"); process.stdout.write(Object.keys(JSON.parse(fs.readFileSync(0, "utf8"))).join("\n"))')" || \
    fail_stage "cannot enumerate staged iOS Info.plist keys for $target"

  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    if ! project_property_json "$project_dump" "$target" "$key" >/dev/null 2>&1; then
      property_type="$(/usr/bin/plutil -type "$key" -- "$plist")" || fail_stage "staged project property is missing $key"
      case "$property_type" in
        array)
          property_value="$(/usr/bin/plutil -extract "$key" json -o - -- "$plist")" || \
            fail_stage "cannot read staged project array $key"
          ;;
        bool|string)
          property_value="$(/usr/bin/plutil -extract "$key" raw -o - -- "$plist")" || \
            fail_stage "cannot read staged project property $key"
          if [[ "$property_type" == "string" ]]; then
            property_value="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$property_value")"
          fi
          ;;
        *) fail_stage "unsupported staged project property type $property_type for $key" ;;
      esac
      missing+=$'        '"$key"$': '"$property_value"$'\n'
    fi
  done <<< "$plist_keys"
  [[ -n "$missing" ]] || return 0

  MISSING_PROPERTIES="$missing" awk -v target="$target" '
    $0 == "  " target ":" { in_target = 1; print; next }
    in_target && !inserted && $0 ~ /^        CFBundleVersion:/ {
      print
      printf "%s", ENVIRON["MISSING_PROPERTIES"]
      inserted = 1
      next
    }
    in_target && $0 ~ /^  [^[:space:]]/ { in_target = 0 }
    { print }
    END {
      if (!inserted) exit 1
    }
  ' "$project_yml" > "$tmp" || {
    rm -f "$tmp"
    fail_stage "cannot persist canonical iOS Info.plist properties in $target"
  }
  mv "$tmp" "$project_yml"
}

sync_staged_ios_metadata() {
  local stage_root="$1"
  local apple_root="$stage_root/src-tauri/gen/apple"
  local project_yml="$apple_root/project.yml"
  local target transaction_tmp_parent
  local -a targets=()
  [[ -d "$apple_root" ]] || fail_stage "staged Apple directory is missing"
  [[ -f "$project_yml" ]] || fail_stage "staged project.yml is missing"
  validate_staged_apple_project "$stage_root"
  for target in app_iOS gai_iOS; do
    if [[ -d "$apple_root/$target" ]]; then
      targets+=("$target")
    fi
  done
  (( ${#targets[@]} > 0 )) || fail_stage "staged iOS target directory is missing"

  transaction_tmp_parent="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
  begin_staged_ios_metadata_transaction "$transaction_tmp_parent"
  backup_staged_ios_metadata_file "$project_yml" project.yml
  for target in "${targets[@]}"; do
    backup_staged_ios_metadata_file "$apple_root/$target/Info.plist" "$target-Info.plist"
  done
  for target in "${targets[@]}"; do
    sync_staged_ios_plist "$apple_root/$target/Info.plist"
    sync_staged_project_yml_properties "$project_yml" "$target" "$apple_root/$target/Info.plist"
  done
  commit_staged_ios_metadata_transaction
}

if [[ "${1:-}" == "--sync-ios-metadata" ]]; then
  [[ $# -eq 2 ]] || fail_stage "usage: $0 --sync-ios-metadata STAGE_ROOT"
  sync_staged_ios_metadata "$2"
  exit 0
fi

# 六 GiB 是最低起跑門檻，實際 archive 仍可能需要更多空間。
stage_tmp_parent="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
free_kib="$(df -Pk "$stage_tmp_parent" | awk 'NR == 2 { print $4 }')"
if [[ ! "$free_kib" =~ ^[0-9]+$ ]] || (( free_kib < 6 * 1024 * 1024 )); then
  echo "本機暫存磁碟可用空間不足 6 GiB，未建立建置副本。" >&2
  exit 3
fi
stage_root=""
stage_keep=0
cleanup_stage_on_exit() {
  local incoming_status="$?"
  local status
  if (( $# > 0 )); then
    status="$1"
  else
    status="$incoming_status"
  fi
  if (( stage_keep == 0 )) &&
    [[ -n "$stage_root" && "$stage_root" == "$stage_tmp_parent"/gai-ios-stage.* && -d "$stage_root" ]]; then
    rm -rf -- "$stage_root"
  fi
  exit "$status"
}
trap cleanup_stage_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
stage_root="$(mktemp -d "$stage_tmp_parent/gai-ios-stage.XXXXXX")"
for entry in public src-tauri scripts package.json package-lock.json rust-toolchain.toml LICENSE; do
  rsync -a --exclude='.cargo/' --exclude='target/' --exclude='.build/' --exclude='gen/apple/build/' \
    --exclude='gen/apple/Externals/' --exclude='gen/apple/assets/' \
    "$source_root/$entry" "$stage_root/"
done
# 不複製 SMB 上的 node_modules：其 .bin symlink 可能已變成一般檔案。
# 呼叫端進入副本後以 npm ci --ignore-scripts 依 lockfile 安裝建置依賴。
mkdir -p "$stage_root/src-tauri/gen/apple/Externals" "$stage_root/src-tauri/gen/apple/assets"
migrate_staged_apple_project "$stage_root"
sync_staged_ios_metadata "$stage_root"
# stdout is a hand-off protocol: callers must require exit 0 before using this path.
# Keep the directory only after the complete path line was written successfully;
# a later signal/non-zero exit must not leave an unacknowledged stage orphan.
if printf '%s\n' "$stage_root"; then
  stage_keep=1
else
  exit 1
fi
