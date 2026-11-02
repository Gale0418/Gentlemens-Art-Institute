#!/usr/bin/env bash
set -euo pipefail

# Sign and package an already-universal Tauri macOS App Store bundle.
# The source app is never mutated. All chmod/profile/signing/package work is
# performed in a task-scoped staging directory and committed only on success.

usage() {
  cat >&2 <<'EOF'
Usage:
  sign-macos-app-store.sh \
    --app SOURCE_APP_PATH \
    --output-app SIGNED_APP_PATH \
    --profile MAC_APP_STORE_PROFILE \
    --pkg OUTPUT_PKG \
    --version VERSION \
    --build-number BUILD_NUMBER \
    --application-identity "3rd Party Mac Developer Application: ..." \
    --installer-identity "3rd Party Mac Developer Installer: ..."
EOF
  exit 2
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 2
}

APP_PATH=''
OUTPUT_APP_PATH=''
PROFILE_PATH=''
PKG_PATH=''
EXPECTED_VERSION=''
EXPECTED_BUILD=''
APPLICATION_IDENTITY=''
INSTALLER_IDENTITY=''

while (($# > 0)); do
  case "$1" in
    --app) APP_PATH=${2-}; shift 2 ;;
    --output-app) OUTPUT_APP_PATH=${2-}; shift 2 ;;
    --profile) PROFILE_PATH=${2-}; shift 2 ;;
    --pkg) PKG_PATH=${2-}; shift 2 ;;
    --version) EXPECTED_VERSION=${2-}; shift 2 ;;
    --build-number) EXPECTED_BUILD=${2-}; shift 2 ;;
    --application-identity) APPLICATION_IDENTITY=${2-}; shift 2 ;;
    --installer-identity) INSTALLER_IDENTITY=${2-}; shift 2 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

for required in APP_PATH OUTPUT_APP_PATH PROFILE_PATH PKG_PATH EXPECTED_VERSION EXPECTED_BUILD \
  APPLICATION_IDENTITY INSTALLER_IDENTITY; do
  [[ -n "${!required}" ]] || fail "${required} is required"
done

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
APP_ENTITLEMENTS="$ROOT_DIR/src-tauri/Entitlements-macOS.plist"
HELPER_ENTITLEMENTS="$ROOT_DIR/src-tauri/Entitlements-macOS-helper.plist"

for command_name in codesign lipo productbuild pkgutil security plutil grep file; do
  command -v "$command_name" >/dev/null || fail "missing command: $command_name"
done
[[ -d "$APP_PATH/Contents/MacOS" ]] || fail "invalid source app bundle: $APP_PATH"
[[ -f "$APP_ENTITLEMENTS" ]] || fail "missing app entitlements: $APP_ENTITLEMENTS"
[[ -f "$HELPER_ENTITLEMENTS" ]] || fail "missing helper entitlements: $HELPER_ENTITLEMENTS"
[[ -f "$PROFILE_PATH" ]] || fail "missing provisioning profile: $PROFILE_PATH"

source_app_real=$(cd "$APP_PATH" && pwd -P) || fail "cannot canonicalize source App: $APP_PATH"
[[ -d "$source_app_real/Contents/MacOS" ]] || fail "invalid source App bundle: $source_app_real"

paths_overlap() {
  case "$1" in
    "$2"|"$2"/*) return 0 ;;
  esac
  case "$2" in
    "$1"|"$1"/*) return 0 ;;
  esac
  return 1
}

# Resolve an output path component by component without creating anything.
# Resolve existing symlinks before applying .., matching filesystem lookup
# semantics so an alias/../source.app path cannot hide an overlap.
canonicalize_allow_missing() {
  local candidate=$1
  local candidate_abs component current next
  local -a components
  [[ "$candidate" = /* ]] && candidate_abs=$candidate || \
    candidate_abs="$(pwd -P)/$candidate"
  IFS='/' read -r -a components <<< "${candidate_abs#/}"
  current='/'
  for component in "${components[@]}"; do
    case "$component" in
      ''|.) continue ;;
      ..)
        [[ "$current" == '/' ]] || current=$(dirname "$current")
        ;;
      *)
        [[ "$current" == '/' ]] && next="/$component" || next="$current/$component"
        if [[ -d "$next" ]]; then
          current=$(cd "$next" && pwd -P)
        else
          [[ ! -L "$next" ]] || fail "cannot resolve output symlink: $next"
          current=$next
        fi
        ;;
    esac
  done
  printf '%s\n' "$current"
}

[[ ! -e "$OUTPUT_APP_PATH" && ! -L "$OUTPUT_APP_PATH" ]] || \
  fail "output App already exists: $OUTPUT_APP_PATH"
[[ ! -e "$PKG_PATH" && ! -L "$PKG_PATH" ]] || \
  fail "output PKG already exists: $PKG_PATH"

output_app_real=$(canonicalize_allow_missing "$OUTPUT_APP_PATH")
pkg_real=$(canonicalize_allow_missing "$PKG_PATH")
paths_overlap "$source_app_real" "$output_app_real" && \
  fail 'source App and output App paths overlap'
paths_overlap "$source_app_real" "$pkg_real" && \
  fail 'source App and output PKG paths overlap'
paths_overlap "$output_app_real" "$pkg_real" && \
  fail 'output App and PKG paths overlap'

output_app_parent=$(dirname "$OUTPUT_APP_PATH")
pkg_parent=$(dirname "$PKG_PATH")
mkdir -p "$output_app_parent" "$pkg_parent"
output_app_parent=$(cd "$output_app_parent" && pwd -P)
pkg_parent=$(cd "$pkg_parent" && pwd -P)
[[ "$(stat -f '%d' "$output_app_parent")" == "$(stat -f '%d' "$pkg_parent")" ]] || \
  fail 'output App and PKG must be on the same filesystem for clean atomic commit'

stage_root=$(mktemp -d "$output_app_parent/.gai-macos-sign.XXXXXX")
app_commit_started=0
pkg_commit_started=0
app_committed=0
pkg_committed=0
cleanup() {
  if [[ -n "${stage_root:-}" && -d "$stage_root" ]]; then
    rm -rf -- "$stage_root"
  fi
}
rollback_committed_outputs() {
  if (( pkg_commit_started == 1 || pkg_committed == 1 )); then
    rm -rf -- "$PKG_PATH"
    pkg_commit_started=0
    pkg_committed=0
  fi
  if (( app_commit_started == 1 || app_committed == 1 )); then
    rm -rf -- "$OUTPUT_APP_PATH"
    app_commit_started=0
    app_committed=0
  fi
}
on_exit() {
  local status=$?
  if (( status != 0 )); then
    rollback_committed_outputs
  fi
  cleanup
  exit "$status"
}
on_signal() {
  local signal=$1
  rollback_committed_outputs
  cleanup
  if [[ "$signal" == INT ]]; then
    exit 130
  fi
  exit 143
}
trap on_exit EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

staged_app="$stage_root/$(basename "$OUTPUT_APP_PATH")"
staged_pkg="$stage_root/$(basename "$PKG_PATH")"
cp -R "$source_app_real" "$staged_app"

profile_plist="$stage_root/profile.plist"
security cms -D -i "$PROFILE_PATH" > "$profile_plist" || \
  fail 'provisioning profile is not a valid CMS profile'
profile_app_id=$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:com.apple.application-identifier' \
  "$profile_plist" 2>/dev/null) || fail 'profile application identifier is missing'
profile_bundle_id=${profile_app_id#*.}
profile_team=$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:com.apple.developer.team-identifier' \
  "$profile_plist" 2>/dev/null) || fail 'profile team identifier is missing'
profile_platform=$(/usr/libexec/PlistBuddy -c 'Print :Platform:0' \
  "$profile_plist" 2>/dev/null) || fail 'profile platform is missing'
profile_expiration=$(/usr/bin/plutil -extract ExpirationDate raw -o - "$profile_plist" 2>/dev/null) || \
  fail 'profile expiration is missing'
profile_expiration_epoch=$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$profile_expiration" '+%s') || \
  fail 'profile expiration has an invalid date'
now_epoch=$(date -u '+%s')
(( profile_expiration_epoch > now_epoch )) || fail 'provisioning profile is expired'
profile_get_task_allow=$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:get-task-allow' \
  "$profile_plist" 2>/dev/null || true)
[[ "$profile_get_task_allow" != 'true' ]] || \
  fail 'distribution provisioning profile must not contain get-task-allow=true'
[[ "$profile_platform" == 'OSX' ]] || fail "profile platform is not OSX: $profile_platform"

bundle_identifier=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
  "$staged_app/Contents/Info.plist" 2>/dev/null) || fail 'CFBundleIdentifier is missing'
main_executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' \
  "$staged_app/Contents/Info.plist" 2>/dev/null) || fail 'CFBundleExecutable is missing'
actual_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "$staged_app/Contents/Info.plist" 2>/dev/null) || fail 'CFBundleShortVersionString is missing'
actual_build=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' \
  "$staged_app/Contents/Info.plist" 2>/dev/null) || fail 'CFBundleVersion is missing'
[[ "$bundle_identifier" == "$profile_bundle_id" ]] || \
  fail "bundle/profile mismatch: $bundle_identifier vs $profile_bundle_id"
[[ "$actual_version" == "$EXPECTED_VERSION" ]] || \
  fail "version mismatch: expected $EXPECTED_VERSION, got $actual_version"
[[ "$actual_build" == "$EXPECTED_BUILD" ]] || \
  fail "build mismatch: expected $EXPECTED_BUILD, got $actual_build"

identity_team=$(printf '%s\n' "$APPLICATION_IDENTITY" | sed -n 's/.*(\([A-Za-z0-9][A-Za-z0-9]*\))$/\1/p')
[[ -n "$identity_team" ]] || fail 'application identity has no team identifier'
[[ "$identity_team" == "$profile_team" ]] || \
  fail "application identity/profile team mismatch: $identity_team vs $profile_team"
[[ "$INSTALLER_IDENTITY" == *"($profile_team)"* ]] || \
  fail 'installer identity/profile team mismatch'
security find-identity -v -p codesigning | grep -F "\"$APPLICATION_IDENTITY\"" >/dev/null || \
  fail "application signing identity is not available: $APPLICATION_IDENTITY"
security find-identity -v | grep -F "\"$INSTALLER_IDENTITY\"" >/dev/null || \
  fail "installer signing identity is not available: $INSTALLER_IDENTITY"

cp "$PROFILE_PATH" "$staged_app/Contents/embedded.provisionprofile"
find "$staged_app" -type d -exec chmod 755 {} +
find "$staged_app" -type f -exec chmod u+rwX,go+rX {} +
chmod 644 "$staged_app/Contents/embedded.provisionprofile" "$staged_app/Contents/Resources/icon.icns"

executables=()
while IFS= read -r executable; do
  executables+=( "$executable" )
done < <(find "$staged_app/Contents/MacOS" -maxdepth 1 -type f -print | sort)
[[ "${#executables[@]}" -gt 0 ]] || fail 'no Contents/MacOS executables found'
main_path="$staged_app/Contents/MacOS/$main_executable"
[[ -f "$main_path" ]] || fail "main executable is missing: $main_path"

for executable in "${executables[@]}"; do
  [[ "$executable" == "$main_path" ]] && continue
  printf 'Signing sandboxed helper: %s\n' "$executable"
  codesign --force --verbose --options runtime \
    --entitlements "$HELPER_ENTITLEMENTS" \
    --sign "$APPLICATION_IDENTITY" "$executable"
done

printf 'Signing sandboxed main app executable: %s\n' "$main_path"
codesign --force --verbose --options runtime \
  --entitlements "$APP_ENTITLEMENTS" \
  --sign "$APPLICATION_IDENTITY" "$main_path"

printf 'Signing outer app after helpers: %s\n' "$staged_app"
codesign --force --verbose --options runtime \
  --entitlements "$APP_ENTITLEMENTS" \
  --sign "$APPLICATION_IDENTITY" "$staged_app"

entitlements_dump() {
  codesign -d --entitlements :- "$1" 2>/dev/null | plutil -p -
}

signature_dump() {
  codesign -dv --verbose=4 "$1" 2>&1
}

require_signature_identity() {
  local executable=$1
  signature_dump "$executable" | grep -F "Authority=$APPLICATION_IDENTITY" >/dev/null || \
    fail "signature identity mismatch: $executable"
}

require_entitlement() {
  local executable=$1
  local entitlement=$2
  local dump
  dump=$(entitlements_dump "$executable") || fail "cannot read entitlements: $executable"
  printf '%s\n' "$dump" | grep -F "\"$entitlement\" => true" >/dev/null || \
    fail "missing entitlement $entitlement in $executable"
}

require_no_entitlement() {
  local executable=$1
  local entitlement=$2
  local dump
  dump=$(entitlements_dump "$executable") || fail "cannot read entitlements: $executable"
  if printf '%s\n' "$dump" | grep -F "\"$entitlement\" => true" >/dev/null; then
    fail "forbidden entitlement $entitlement in $executable"
  fi
}

require_exact_helper_entitlements() {
  local executable=$1
  local dump
  local keys
  local true_count
  dump=$(entitlements_dump "$executable") || fail "cannot read helper entitlements: $executable"
  keys=$(printf '%s\n' "$dump" | sed -n 's/^[[:space:]]*"\([^"]*\)" => .*/\1/p' | sort)
  [[ "$keys" == $'com.apple.security.app-sandbox\ncom.apple.security.inherit' ]] || \
    fail "helper entitlements are not exactly sandbox+inherit: $executable"
  true_count=$(printf '%s\n' "$dump" | grep -c '=> true$' || true)
  [[ "$true_count" == '2' ]] || fail "helper true entitlement count is not 2: $executable"
}

require_exact_universal_architectures() {
  local executable=$1
  local architecture_output
  local architecture_list
  local -a architectures=()
  architecture_output=$(lipo -archs "$executable") || \
    fail "cannot read architectures: $executable"
  read -r -a architectures <<< "$architecture_output"
  architecture_list=${architectures[*]-}
  [[ "${#architectures[@]}" == '2' ]] && \
    [[ "$architecture_list" == 'arm64 x86_64' || "$architecture_list" == 'x86_64 arm64' ]] || \
    fail "unexpected architectures (only arm64+x86_64 allowed): $executable: $architecture_output"
}

for executable in "${executables[@]}"; do
  codesign --verify --strict --verbose=2 "$executable"
  require_signature_identity "$executable"
  file_output=$(file "$executable")
  printf '%s\n' "$file_output" | grep -F 'Mach-O' >/dev/null || \
    fail "not a Mach-O executable: $executable"
  lipo "$executable" -verify_arch arm64 x86_64 >/dev/null 2>&1 || \
    fail "arm64+x86_64 universal architecture missing: $executable"
  require_exact_universal_architectures "$executable"
  require_entitlement "$executable" 'com.apple.security.app-sandbox'
  if [[ "$executable" == "$main_path" ]]; then
    require_no_entitlement "$executable" 'com.apple.security.inherit'
    require_no_entitlement "$executable" 'com.apple.security.get-task-allow'
  else
    require_exact_helper_entitlements "$executable"
  fi
done

codesign --verify --deep --strict --verbose=2 "$staged_app"
require_signature_identity "$staged_app"
signature_dump "$staged_app" | grep -F "Identifier=$bundle_identifier" >/dev/null || \
  fail "signed bundle identifier mismatch: $staged_app"
productbuild --component "$staged_app" /Applications \
  --sign "$INSTALLER_IDENTITY" "$staged_pkg"
pkgutil --check-signature "$staged_pkg"
pkgutil --payload-files "$staged_pkg" | grep -F "$main_executable" >/dev/null || \
  fail 'PKG payload is missing the main executable'

app_commit_started=1
if ! mv "$staged_app" "$OUTPUT_APP_PATH"; then
  fail "could not commit signed App: $OUTPUT_APP_PATH"
fi
app_committed=1
pkg_commit_started=1
if ! mv "$staged_pkg" "$PKG_PATH"; then
  fail "could not commit signed PKG: $PKG_PATH"
fi
pkg_committed=1
# The staging directory still contains the decoded profile and must be removed
# after both output moves. EXIT remains armed as an idempotent safety net.
cleanup

printf 'PASS: macOS App Store app and PKG signed/verified\n'
printf '  app=%s\n  pkg=%s\n  version=%s (%s)\n' \
  "$OUTPUT_APP_PATH" "$PKG_PATH" "$EXPECTED_VERSION" "$EXPECTED_BUILD"
