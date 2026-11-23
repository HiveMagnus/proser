#!/usr/bin/env python3
"""Provision host-local PostgreSQL credentials without exposing their values."""

from pathlib import Path
import os
import secrets
import sys
import tempfile
from urllib.parse import quote


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
    if len(sys.argv) not in (2, 3):
        print("usage: ensure-postgres-env.py <env-file> [credential-source-env]", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    values: dict[str, str] = {}
    for line in lines:
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("\"'")

    source_password = ""
    source_signing_key = ""
    if len(sys.argv) == 3:
        source = Path(sys.argv[2])
        for line in source.read_text(encoding="utf-8").splitlines():
            if line.startswith("POSTGRES_PASSWORD="):
                source_password = line.partition("=")[2].strip().strip("\"'")
            elif line.startswith("MIGRATION_EVIDENCE_SIGNING_KEY="):
                source_signing_key = line.partition("=")[2].strip().strip("\"'")
        if not source_password:
            print("credential source has no POSTGRES_PASSWORD", file=sys.stderr)
            return 1
        if len(source_signing_key) < 32:
            print("credential source has no strong MIGRATION_EVIDENCE_SIGNING_KEY", file=sys.stderr)
            return 1

    password = source_password or values.get("POSTGRES_PASSWORD") or secrets.token_urlsafe(48)
    updates = {
        "POSTGRES_PASSWORD": password,
        "DATABASE_URL": (
            "postgresql://proser:"
            f"{quote(password, safe='')}@127.0.0.1:5432/proser"
        ),
        "DATABASE_POOL_SIZE": values.get("DATABASE_POOL_SIZE") or "20",
        "MIGRATION_EVIDENCE_SIGNING_KEY": (
            source_signing_key
            or values.get("MIGRATION_EVIDENCE_SIGNING_KEY")
            or secrets.token_urlsafe(48)
        ),
    }

    next_lines: list[str] = []
    seen: set[str] = set()
    for line in lines:
        if "=" not in line or line.lstrip().startswith("#"):
            next_lines.append(line)
            continue
        key = line.split("=", 1)[0].strip()
        if key in updates:
            if key not in seen:
                next_lines.append(f"{key}={updates[key]}")
                seen.add(key)
            continue
        if key == "SQLITE_BUSY_TIMEOUT_MS":
            continue
        next_lines.append(line)

    for key, value in updates.items():
        if key not in seen:
            next_lines.append(f"{key}={value}")

    write_private(path, "\n".join(next_lines).rstrip() + "\n")
    print("PostgreSQL runtime environment present")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
