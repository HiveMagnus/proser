#!/usr/bin/env python3
"""Provision or verify Factory's dedicated Author-to-Factory signing key."""

from __future__ import annotations

import os
from pathlib import Path
import re
import stat
import sys
import tempfile


KEY = "FACTORY_AUTH_SECRET"


def require_private_file(path: Path, *, root_owned: bool) -> list[str]:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise SystemExit(f"{path} must be an absolute regular non-symlink file")
    if path.resolve(strict=True) != path:
        raise SystemExit(f"{path} must not traverse symlinks")
    metadata = path.stat()
    if metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise SystemExit(f"{path} must have one link and mode 0600")
    if root_owned and metadata.st_uid != 0:
        raise SystemExit(f"{path} must be root-owned")
    return path.read_text(encoding="utf-8").splitlines()


def values(lines: list[str]) -> list[str]:
    return [
        line.partition("=")[2].strip().strip("\"'")
        for line in lines
        if line.startswith(f"{KEY}=")
    ]


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: ensure-shared-factory-auth.py FACTORY_ENV AUTHOR_ENV")

    target = Path(sys.argv[1])
    source = Path(sys.argv[2])
    target_lines = require_private_file(target, root_owned=True)
    source_values = values(require_private_file(source, root_owned=False))
    if len(source_values) != 1:
        raise SystemExit(f"{source} must contain {KEY} exactly once")
    shared_secret = source_values[0]
    if not re.fullmatch(r"[A-Za-z0-9._~+/=-]{32,512}", shared_secret):
        raise SystemExit(f"{source} contains a weak or non-portable {KEY}")

    target_values = values(target_lines)
    if len(target_values) > 1:
        raise SystemExit(f"{target} contains {KEY} more than once")
    if target_values and target_values[0] != shared_secret:
        raise SystemExit(f"{KEY} differs between Author and Factory; explicit rotation required")
    if target_values:
        print("Author-to-Factory credential present")
        return os.EX_OK

    target_lines.append(f"{KEY}={shared_secret}")
    content = "\n".join(target_lines).rstrip() + "\n"
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.factory-auth-",
        dir=target.parent,
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        directory_descriptor = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary.unlink(missing_ok=True)
        raise
    print("Author-to-Factory credential provisioned")
    return os.EX_OK


if __name__ == "__main__":
    raise SystemExit(main())
