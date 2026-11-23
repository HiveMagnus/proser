#!/usr/bin/env python3
"""Provision the host-local metrics credential without exposing its value."""

from pathlib import Path
import os
import secrets
import sys
import tempfile


def write_private(path: Path, content: str) -> None:
    """Replace path atomically. The file is never readable beyond its owner,
    not even between creation and chmod, and keeps an existing owner."""
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        if path.exists() and os.geteuid() == 0:
            current = path.stat()
            os.fchown(descriptor, current.st_uid, current.st_gid)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: ensure-metrics-token.py <env-file>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    for line in lines:
        if line.startswith("METRICS_TOKEN=") and line.partition("=")[2].strip().strip("\"'"):
            print("metrics credential present")
            return 0
    lines = [line for line in lines if not line.startswith("METRICS_TOKEN=")]
    lines.append(f"METRICS_TOKEN={secrets.token_hex(32)}")
    write_private(path, "\n".join(lines).rstrip() + "\n")
    print("metrics credential provisioned")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
