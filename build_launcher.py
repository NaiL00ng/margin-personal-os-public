"""用现有 macOS Swift 工具构建本机 Margin.app；不下载、不安装、不启动服务。"""

import os
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parent
APP = ROOT / "Margin.app"
BUNDLE_ID = "local.margin.launcher"


def main():
    if sys.platform != "darwin" or not shutil.which("swiftc"):
        raise SystemExit("需要本机已有的 macOS Swift 编译工具；本脚本不会安装工具。")
    if APP.is_symlink():
        raise SystemExit("Margin.app 是符号链接，拒绝覆盖。")
    if APP.exists():
        try:
            previous = plistlib.loads((APP / "Contents/Info.plist").read_bytes())
        except Exception:
            raise SystemExit("已有 Margin.app 无法识别，拒绝覆盖。")
        if previous.get("CFBundleIdentifier") != BUNDLE_ID:
            raise SystemExit("已有同名应用属于其他项目，拒绝覆盖。")
    cache = ROOT / ".local" / "launcher-build"
    if cache.parent.is_symlink() or cache.is_symlink():
        raise SystemExit("构建缓存不能是符号链接，避免写入项目外。")
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="build-", dir=cache) as scratch:
        stage = Path(scratch) / "Margin.app"
        contents = stage / "Contents"
        executable = contents / "MacOS" / "MarginLauncher"
        resources = contents / "Resources"
        executable.parent.mkdir(parents=True)
        resources.mkdir()
        subprocess.run([
            shutil.which("swiftc"), "-swift-version", "5", "-O",
            "-module-cache-path", str(cache / "modules"),
            str(ROOT / "launcher" / "MarginLauncher.swift"),
            "-o", str(executable),
        ], cwd=ROOT, check=True)
        png = resources / "AppIcon.png"
        subprocess.run([str(executable), "--render-icon", str(png)], cwd=ROOT, check=True)
        image = png.read_bytes()
        icon = b"ic10" + struct.pack(">I", len(image) + 8) + image
        (resources / "AppIcon.icns").write_bytes(b"icns" + struct.pack(">I", len(icon) + 8) + icon)
        version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
        (contents / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": BUNDLE_ID,
            "CFBundleName": "Margin",
            "CFBundleDisplayName": "余白 MARGIN",
            "CFBundleExecutable": "MarginLauncher",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": version.split("-")[0],
            "CFBundleVersion": "2",
            "CFBundleIconFile": "AppIcon",
            "NSHighResolutionCapable": True,
            "MarginProjectPath": str(ROOT),
            "MarginPythonPath": sys.executable,
            "MarginSourceVersion": version,
        }, sort_keys=True))
        # Rebuilds retain the previous bundle locally; only generated bundles are moved.
        if APP.exists():
            archive = cache / ("previous-" + uuid.uuid4().hex + ".app")
            APP.rename(archive)
        shutil.move(str(stage), str(APP))
        os.chmod(APP / "Contents/MacOS/MarginLauncher", 0o755)
    print("已生成：" + str(APP))


if __name__ == "__main__":
    main()
