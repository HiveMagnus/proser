#!/usr/bin/env python3
"""Provision the host-local metrics credential without exposing its value."""

from pathlib import Path
import os
import secrets
import sys


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
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    os.chmod(path, 0o600)
    print("metrics credential provisioned")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
