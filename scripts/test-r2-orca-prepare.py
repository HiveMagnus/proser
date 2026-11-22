#!/usr/bin/env python3
"""Extract distro Orca test tools privately; never install global packages."""
import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="output/playwright/r2/orca")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    repository = Path(__file__).resolve().parent.parent
    if not output.is_relative_to(repository / "output/playwright"):
        raise ValueError("Orca test packages must stay under ignored output/playwright")
    packages, runtime = output / "packages", output / "runtime"
    packages.mkdir(parents=True, exist_ok=True)
    runtime.mkdir(exist_ok=True)
    lock = (output / "orca-runtime.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    query = subprocess.run(["apt-cache", "depends", "--recurse", "--no-recommends", "--no-suggests", "--no-conflicts", "--no-breaks", "--no-replaces", "--no-enhances", "orca", "python3-pyatspi"], check=True, capture_output=True, text=True)
    names = sorted({line.strip() for line in query.stdout.splitlines() if line and not line.startswith((" ", "<"))})
    missing = []
    for name in names:
        status = subprocess.run(["dpkg-query", "-W", "-f=${db:Status-Status}", name], capture_output=True, text=True)
        if status.stdout != "installed":
            missing.append(name)
    if missing:
        download = subprocess.run(["apt-get", "download", *missing], cwd=packages, capture_output=True)
        (output / "download.log").write_bytes(download.stdout + download.stderr)
        download.check_returncode()
    records = []
    for package in sorted(packages.glob("*.deb")):
        metadata = subprocess.run(["dpkg-deb", "-f", str(package), "Package", "Version", "Architecture"], capture_output=True, text=True, check=True).stdout.strip()
        digest = hashlib.sha256(package.read_bytes()).hexdigest()
        subprocess.run(["dpkg-deb", "-x", str(package), str(runtime)], check=True)
        records.append({"archive": package.name, "sha256": digest, "metadata": metadata})
    (output / "tool-packages.json").write_text(json.dumps({"source": "configured distro APT repositories", "globalInstallation": False, "packages": records}, indent=2) + "\n")
    print(json.dumps({"status": "prepared", "packageCount": len(records), "runtime": str(runtime)}))


if __name__ == "__main__":
    main()
