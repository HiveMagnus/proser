#!/usr/bin/env python3
"""Normalize and validate Proser codex-entry drafts."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


VALID_TYPES = {
    "character",
    "location",
    "lore",
    "item",
    "faction",
    "event",
    "rule",
    "culture",
    "relationship",
}

TYPE_ALIASES = {
    "characters": "character",
    "person": "character",
    "people": "character",
    "place": "location",
    "places": "location",
    "artifact": "item",
    "object": "item",
    "organization": "faction",
    "group": "faction",
    "history": "lore",
    "law": "rule",
    "custom": "culture",
    "bond": "relationship",
}

PIPE_BULLET_RE = re.compile(r"^\s*[-*]\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)(?:\s*\|\s*(.+))?\s*$")
BRACKET_BULLET_RE = re.compile(r"^\s*[-*]\s*\[([A-Za-z _-]+)\]\s*([^:]+?)(?:\s*:\s*(.+))?\s*$")
HEADING_RE = re.compile(r"^\s*#{1,6}\s*(?:\[([A-Za-z _-]+)\]\s*)?(?:(\w[\w _-]*)\s*:\s*)?(.+?)\s*$")
MARKUP_RE = re.compile(r"^([*_`~]+)(.+?)\1$")


def normalize_type(value: Any) -> str:
    text = str(value or "").strip().lower().replace("_", "-").replace(" ", "-")
    text = TYPE_ALIASES.get(text, text)
    return text


def clean_name(value: Any) -> str:
    text = " ".join(str(value or "").strip().split())
    match = MARKUP_RE.match(text)
    if match:
        text = match.group(2).strip()
    text = text.strip(" :;-")
    return text


def clean_description(value: Any) -> str:
    return "\n".join(line.rstrip() for line in str(value or "").strip().splitlines()).strip()


def normalize_attributes(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return text
        return json.dumps(parsed, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def normalize_entry(raw: dict[str, Any], index: int, errors: list[str], warnings: list[str]) -> dict[str, Any] | None:
    entry_type = normalize_type(raw.get("entryType") or raw.get("entry_type") or raw.get("type") or raw.get("kind"))
    name = clean_name(raw.get("entryName") or raw.get("entry_name") or raw.get("name"))
    description = clean_description(
        raw.get("entryDescription") or raw.get("entry_description") or raw.get("description") or raw.get("summary")
    )
    attributes = normalize_attributes(raw.get("attributes") if "attributes" in raw else raw.get("attributes_json"))

    label = f"entry[{index}]"
    if entry_type not in VALID_TYPES:
        errors.append(f"{label}: invalid entryType '{entry_type or '<missing>'}'")
    if not name:
        errors.append(f"{label}: entryName is required")
    if len(name) > 255:
        errors.append(f"{label}: entryName exceeds 255 characters")
    if len(description) > 5000:
        errors.append(f"{label}: entryDescription exceeds 5000 characters")
    if attributes and len(attributes) > 50000:
        errors.append(f"{label}: attributes exceeds 50000 characters")
    if not description:
        warnings.append(f"{label}: entryDescription is empty")

    if entry_type not in VALID_TYPES or not name:
        return None

    normalized: dict[str, Any] = {
        "entryType": entry_type,
        "entryName": name,
        "entryDescription": description,
    }
    if attributes:
        normalized["attributes"] = attributes
    return normalized


def source_from_json(raw: str) -> list[dict[str, Any]]:
    parsed = json.loads(raw)
    if isinstance(parsed, dict):
        if isinstance(parsed.get("entries"), list):
            return [item for item in parsed["entries"] if isinstance(item, dict)]
        if isinstance(parsed.get("candidates"), list):
            return [item for item in parsed["candidates"] if isinstance(item, dict)]
        return [parsed]
    if isinstance(parsed, list):
        return [item for item in parsed if isinstance(item, dict)]
    raise ValueError("JSON input must be an object, an array, or an object with entries/candidates")


def flush_heading(current: dict[str, Any] | None, entries: list[dict[str, Any]]) -> None:
    if not current:
        return
    description_lines = current.pop("_description_lines", [])
    if description_lines and not current.get("description"):
        current["description"] = "\n".join(description_lines).strip()
    entries.append(current)


def heading_entry(line: str) -> dict[str, Any] | None:
    match = HEADING_RE.match(line)
    if not match:
        return None
    bracket_type, prefix_type, rest = match.groups()
    entry_type = normalize_type(bracket_type or prefix_type)
    if entry_type not in VALID_TYPES:
        return None
    name = re.sub(r"\s+\[[A-Za-z _-]+\]\s*$", "", rest).strip()
    return {"type": entry_type, "name": name, "_description_lines": []}


def bullet_entry(line: str) -> dict[str, Any] | None:
    pipe = PIPE_BULLET_RE.match(line)
    if pipe:
        entry_type, name, description, attributes = pipe.groups()
        if normalize_type(entry_type) in VALID_TYPES:
            return {"type": entry_type, "name": name, "description": description or "", "attributes": attributes}
    bracket = BRACKET_BULLET_RE.match(line)
    if bracket:
        entry_type, name, description = bracket.groups()
        if normalize_type(entry_type) in VALID_TYPES:
            return {"type": entry_type, "name": name, "description": description or ""}
    return None


def source_from_markdown(raw: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    for line in raw.splitlines():
        bullet = bullet_entry(line)
        if bullet:
            flush_heading(current, entries)
            current = None
            entries.append(bullet)
            continue

        heading = heading_entry(line)
        if heading:
            flush_heading(current, entries)
            current = heading
            continue

        if current is not None:
            stripped = line.strip()
            if stripped:
                current.setdefault("_description_lines", []).append(stripped)

    flush_heading(current, entries)
    return entries


def load_source(path: Path) -> list[dict[str, Any]]:
    raw = path.read_text(encoding="utf-8")
    stripped = raw.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        return source_from_json(raw)
    return source_from_markdown(raw)


def build_result(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    errors: list[str] = []
    warnings: list[str] = []
    raw_entries = load_source(Path(args.input))
    normalized: list[dict[str, Any]] = []
    seen: dict[tuple[str, str], int] = {}

    if not raw_entries:
        errors.append("No codex entries found in input")

    for index, raw in enumerate(raw_entries, start=1):
        entry = normalize_entry(raw, index, errors, warnings)
        if not entry:
            continue
        key = (entry["entryType"], entry["entryName"].lower())
        if key in seen:
            warnings.append(f"entry[{index}]: duplicate of entry[{seen[key]}] for {entry['entryType']} '{entry['entryName']}'")
            continue
        seen[key] = index
        normalized.append(entry)

    result: dict[str, Any] = {
        "ok": not errors,
        "entryCount": len(normalized),
        "entries": normalized,
        "warnings": warnings,
        "errors": errors,
    }

    if args.book_id is not None:
        result["createEntryCalls"] = [
            {
                "tool": "proser_codex",
                "args": {
                    "action": "create_entry",
                    "bookId": args.book_id,
                    "body": entry,
                },
            }
            for entry in normalized
        ]

    return result, 2 if errors and not args.no_fail else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Normalize and validate Proser codex-entry drafts.")
    parser.add_argument("input", help="Markdown or JSON draft file.")
    parser.add_argument("--book-id", type=int, default=None, help="Optional Proser book ID for create_entry call scaffolds.")
    parser.add_argument("--compact", action="store_true", help="Emit compact JSON.")
    parser.add_argument("--no-fail", action="store_true", help="Return exit code 0 even when validation errors are found.")
    args = parser.parse_args()

    try:
        result, exit_code = build_result(args)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        result = {"ok": False, "entryCount": 0, "entries": [], "warnings": [], "errors": [str(exc)]}
        exit_code = 2 if not args.no_fail else 0

    if args.compact:
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
