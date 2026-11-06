"""从校验过的上游源码构建固定补丁版；不修改已安装的运行环境。"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request


def build():
    root = Path(__file__).resolve().parent
    manifest = json.loads((root / "upstream.json").read_text())
    patch = root / "patches/strict-runtime.patch"
    assert hashlib.sha256(patch.read_bytes()).hexdigest() == manifest["patchSha256"], "patch hash mismatch"
    with tempfile.TemporaryDirectory(prefix="browser-use-build-") as temporary:
        work = Path(temporary)
        with urllib.request.urlopen(manifest["sourceUrl"], timeout=30) as response:
            payload = response.read()
        assert hashlib.sha256(payload).hexdigest() == manifest["sourceSha256"], "source hash mismatch"
        archive = work / "source.tar.gz"
        archive.write_bytes(payload)
        with tarfile.open(archive) as package:
            package.extractall(work, filter="data")
        source = work / "browser_use-0.13.14"
        subprocess.run(["git", "apply", "--check", str(patch)], cwd=source, check=True)
        subprocess.run(["git", "apply", str(patch)], cwd=source, check=True)
        environment = work / "build-env"
        subprocess.run(["uv", "venv", "--python", sys.executable, str(environment)], check=True)
        python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        subprocess.run(["uv", "pip", "sync", "--python", str(python),
                        str(root / "build-requirements.lock"), "--require-hashes"], check=True)
        wheels = work / "wheels"
        subprocess.run(["uv", "build", "--wheel", "--no-build-isolation", "--python", str(python),
                        "--out-dir", str(wheels), str(source)], check=True,
                       env={**os.environ, "SOURCE_DATE_EPOCH": "1700000000"})
        wheel = wheels / manifest["wheel"]
        assert hashlib.sha256(wheel.read_bytes()).hexdigest() == manifest["wheelSha256"], "wheel hash mismatch"
        output = root / "dist"
        output.mkdir(exist_ok=True)
        shutil.copyfile(wheel, output / wheel.name)
        print(json.dumps({"wheel": str(output / wheel.name), "sha256": manifest["wheelSha256"]}))


if __name__ == "__main__":
    build()
