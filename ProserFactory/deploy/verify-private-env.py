#!/usr/bin/env python3
"""Verify one root-owned private env value without printing it."""

from __future__ import annotations

import hashlib
import hmac
import os
from pathlib import Path
import re
import stat
import sys


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit("usage: verify-private-env.py TARGET_ENV KEY EXPECTED_SHA256")

    target = Path(sys.argv[1])
    key = sys.argv[2]
    expected = sys.argv[3]
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
        raise SystemExit("env key is invalid")
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise SystemExit("expected SHA-256 is invalid")
    if not target.is_absolute() or target.is_symlink() or not target.is_file():
        raise SystemExit("target env must be an absolute regular non-symlink file")
    if target.resolve(strict=True) != target:
        raise SystemExit("target env path must not traverse symlinks")

    metadata = target.stat()
    if metadata.st_uid != 0 or metadata.st_nlink != 1:
        raise SystemExit("target env must be root-owned with exactly one hard link")
    if stat.S_IMODE(metadata.st_mode) != 0o600:
        raise SystemExit("target env must have mode 0600")

    values = [
        line.partition("=")[2]
        for line in target.read_text(encoding="utf-8").splitlines()
        if line.startswith(f"{key}=")
    ]
    if len(values) != 1:
        raise SystemExit(f"{key} must occur exactly once")
    value = values[0]
    actual = hashlib.sha256(value.encode("utf-8")).hexdigest()
    if len(value) < 32 or not hmac.compare_digest(actual, expected):
        raise SystemExit(f"{key} is missing, weak, or differs from the deployment source")
    return os.EX_OK


if __name__ == "__main__":
    raise SystemExit(main())
