#!/usr/bin/env python3
"""Set the public iOS version after Tauri builds its three-part SemVer bundle.

App Store Connect accepts a two-part 1.0 version, while Tauri's configuration
parser requires 1.0.0. Re-sign the changed app with the distribution identity
and the entitlements from its embedded provisioning profile.
"""

import argparse
import hashlib
import plistlib
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path


def run(*args: str) -> bytes:
    return subprocess.check_output(args)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="Original signed IPA")
    parser.add_argument("--output", type=Path, required=True, help="New signed IPA")
    parser.add_argument("--version", required=True, help="App Store version, e.g. 1.0")
    parser.add_argument("--build-number", required=True, help="Unique App Store build number")
    parser.add_argument("--identity", required=True, help="Distribution codesign identity")
    parser.add_argument("--work-dir", type=Path, help="Temporary directory on an APFS/HFS+ volume")
    args = parser.parse_args()

    if not re.fullmatch(r"[1-9]\d*\.\d+(?:\.\d+)?", args.version):
        parser.error("--version must contain two or three numeric components")
    if not re.fullmatch(r"[1-9]\d*", args.build_number):
        parser.error("--build-number must be a positive integer")
    source = args.input.resolve(strict=True)
    destination = args.output.resolve()
    if source == destination:
        parser.error("input and output must differ")
    destination.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="gai-ios-repackage-", dir=args.work_dir) as tmp:
        root = Path(tmp)
        unpacked = root / "unpacked"
        unpacked.mkdir()
        run("ditto", "-x", "-k", str(source), str(unpacked))
        apps = list((unpacked / "Payload").glob("*.app"))
        if len(apps) != 1:
            raise RuntimeError(f"Expected one Payload app, found {len(apps)}")
        app = apps[0]
        # Tauri's generated iOS project can copy the Rust static archive into
        # the app after linking it into CFBundleExecutable. App Store Connect
        # rejects standalone .a files inside an app bundle (ITMS-90171).
        static_archive = app / "libapp.a"
        if static_archive.exists():
            static_archive.unlink()
        profile_path = app / "embedded.mobileprovision"
        if not profile_path.is_file():
            raise RuntimeError("IPA lacks an embedded provisioning profile")
        profile = plistlib.loads(run("security", "cms", "-D", "-i", str(profile_path)))
        entitlements = root / "distribution-entitlements.plist"
        entitlements.write_bytes(plistlib.dumps(profile["Entitlements"]))

        info_path = app / "Info.plist"
        info = plistlib.loads(info_path.read_bytes())
        info["CFBundleShortVersionString"] = args.version
        info["CFBundleVersion"] = args.build_number
        # App Store Connect's encryption questionnaire determined that this
        # app's standard encryption is exempt from documentation requirements.
        info["ITSAppUsesNonExemptEncryption"] = False
        info_path.write_bytes(plistlib.dumps(info))
        run("codesign", "--force", "--sign", args.identity, "--entitlements", str(entitlements), str(app))
        run("codesign", "--verify", "--deep", "--strict", str(app))

        # Preserve Symbols and any future IPA top-level payloads; only the
        # app's version changes. Keep the temporary entitlements outside IPA.
        run("ditto", "-c", "-k", "--sequesterRsrc", str(unpacked), str(destination))
        with zipfile.ZipFile(destination) as archive:
            if any(name.startswith("Payload/") and name.endswith("/libapp.a") for name in archive.namelist()):
                raise RuntimeError("Output IPA still contains libapp.a")
            plist_names = [name for name in archive.namelist() if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", name)]
            if len(plist_names) != 1:
                raise RuntimeError("Output IPA does not contain one app Info.plist")
            packaged = plistlib.loads(archive.read(plist_names[0]))
        if packaged["CFBundleShortVersionString"] != args.version:
            raise RuntimeError("Output IPA version differs from requested version")
        if packaged["CFBundleVersion"] != args.build_number:
            raise RuntimeError("Output IPA build number differs from requested build number")
        if packaged.get("ITSAppUsesNonExemptEncryption") is not False:
            raise RuntimeError("Output IPA does not declare exempt encryption")
        checksum = hashlib.sha256()
        with destination.open("rb") as packaged_file:
            for chunk in iter(lambda: packaged_file.read(1024 * 1024), b""):
                checksum.update(chunk)
        digest = checksum.hexdigest()
        print(f"{packaged['CFBundleIdentifier']} {packaged['CFBundleShortVersionString']} ({packaged['CFBundleVersion']})")
        print(f"SHA-256 {digest}")
        print(destination)


if __name__ == "__main__":
    main()
