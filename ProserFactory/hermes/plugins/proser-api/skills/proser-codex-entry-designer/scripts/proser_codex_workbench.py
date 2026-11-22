#!/usr/bin/env python3
"""Workbench helpers for Proser codex planning, linting, import, and coverage."""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass
from difflib import SequenceMatcher
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

STOP_MENTION_HEADS = {
    "A",
    "Act",
    "After",
    "All",
    "An",
    "And",
    "As",
    "At",
    "Before",
    "But",
    "By",
    "Chapter",
    "For",
    "From",
    "He",
    "Her",
    "His",
    "I",
    "If",
    "In",
    "It",
    "Its",
    "No",
    "Not",
    "On",
    "Or",
    "Scene",
    "She",
    "So",
    "That",
    "The",
    "They",
    "This",
    "To",
    "We",
    "When",
    "With",
}

VAGUE_WORDS = {
    "ancient",
    "complex",
    "dark",
    "deep",
    "important",
    "mysterious",
    "powerful",
    "secret",
    "strange",
    "unique",
    "unknown",
}

CAPITALIZED_ENTITY_RE = re.compile(r"\b(?:[A-Z][A-Za-z']+|The)(?:\s+(?:of|the|and|de|da|van|von|[A-Z][A-Za-z']+)){0,4}")

ALIAS_ROLE_WORDS = {
    "agent",
    "alchemist",
    "ally",
    "apprentice",
    "archivist",
    "assassin",
    "botanist",
    "captain",
    "caretaker",
    "child",
    "chronicler",
    "commander",
    "conspirator",
    "courier",
    "debtor",
    "doctor",
    "enemy",
    "engineer",
    "friend",
    "gardener",
    "guardian",
    "handler",
    "healer",
    "heir",
    "informant",
    "keeper",
    "locksmith",
    "maker",
    "mentor",
    "messenger",
    "mother",
    "oracle",
    "patron",
    "prisoner",
    "protector",
    "rival",
    "scholar",
    "sibling",
    "smuggler",
    "soldier",
    "spy",
    "student",
    "teacher",
    "thief",
    "traitor",
    "warden",
    "witness",
}

RELATIONSHIP_ROLES = {
    "advisor",
    "ally",
    "apprentice",
    "aunt",
    "betrayer",
    "brother",
    "captain",
    "child",
    "commander",
    "conspirator",
    "contact",
    "cousin",
    "creditor",
    "daughter",
    "debtor",
    "enemy",
    "father",
    "friend",
    "guardian",
    "handler",
    "informant",
    "lover",
    "mentor",
    "mother",
    "parent",
    "partner",
    "patron",
    "protector",
    "rival",
    "sister",
    "son",
    "spouse",
    "teacher",
    "uncle",
    "ward",
    "witness",
}

RELATIONSHIP_ROLE_RE = "|".join(re.escape(role) for role in sorted(RELATIONSHIP_ROLES, key=len, reverse=True))

PRESETS: dict[str, dict[str, Any]] = {
    "character": {
        "aliases": [],
        "role": "",
        "affiliations": [],
        "voice": "",
        "wants": "",
        "fears": "",
        "appearance": "",
        "canon_state": {},
    },
    "location": {
        "aliases": [],
        "region": "",
        "sensory_signature": "",
        "rules": [],
        "dangers": [],
        "connected_locations": [],
    },
    "lore": {
        "aliases": [],
        "domain": "",
        "origin": "",
        "known_by": [],
        "contradictions": [],
        "story_use": "",
    },
    "item": {
        "aliases": [],
        "owner": "",
        "appearance": "",
        "capabilities": [],
        "limits": [],
        "current_location": "",
    },
    "faction": {
        "aliases": [],
        "members": [],
        "leaders": [],
        "goals": [],
        "methods": [],
        "rivals": [],
        "symbols": [],
    },
    "event": {
        "aliases": [],
        "date_or_sequence": "",
        "participants": [],
        "cause": "",
        "outcome": "",
        "open_questions": [],
    },
    "rule": {
        "aliases": [],
        "domain": "",
        "statement": "",
        "exceptions": [],
        "cost": "",
        "proof_in_story": "",
    },
    "culture": {
        "aliases": [],
        "people": "",
        "customs": [],
        "taboos": [],
        "materials": [],
        "rituals": [],
    },
    "relationship": {
        "source": "",
        "target": "",
        "relationship": "",
        "status": "",
        "tension": "",
        "evidence": [],
    },
}


@dataclass
class Entry:
    entry_type: str
    name: str
    description: str = ""
    attributes: Any = None
    entry_id: Any = None
    raw: dict[str, Any] | None = None

    def body(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "entryType": self.entry_type,
            "entryName": self.name,
            "entryDescription": self.description,
        }
        attrs = normalize_attributes(self.attributes)
        if attrs:
            body["attributes"] = attrs
        return body


@dataclass
class Scene:
    label: str
    text: str
    scene_id: Any = None
    raw: dict[str, Any] | None = None


def normalize_type(value: Any, default: str = "lore") -> str:
    text = str(value or default).strip().lower().replace("_", "-").replace(" ", "-")
    text = TYPE_ALIASES.get(text, text)
    return text if text in VALID_TYPES else default


def normalize_name(value: Any) -> str:
    return " ".join(str(value or "").strip().strip("*_`~").split())


def normalize_description(value: Any) -> str:
    return "\n".join(line.rstrip() for line in str(value or "").strip().splitlines()).strip()


def normalize_attributes(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            return text
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_any(path_value: str) -> Any:
    path = Path(path_value)
    raw = path.read_text(encoding="utf-8")
    stripped = raw.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        return json.loads(raw)
    return raw


def plugin_root() -> Path:
    return Path(__file__).resolve().parents[3]


def load_plugin_tools() -> Any:
    tools_path = plugin_root() / "tools.py"
    spec = importlib.util.spec_from_file_location("proser_api_tools_for_codex_workbench", tools_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load Proser plugin tools from {tools_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def call_plugin_tool(tool_name: str, tool_args: dict[str, Any]) -> dict[str, Any]:
    tools = load_plugin_tools()
    handler = getattr(tools, tool_name, None)
    if handler is None:
        raise RuntimeError(f"Proser plugin tool not found: {tool_name}")
    result = handler(tool_args)
    parsed = json.loads(result)
    if not isinstance(parsed, dict):
        raise RuntimeError(f"Unexpected non-object response from {tool_name}")
    return parsed


def api_fixture(args: argparse.Namespace, key: str) -> Any | None:
    fixture = getattr(args, "api_fixture", None)
    if not fixture:
        return None
    data = load_any(fixture)
    if not isinstance(data, dict):
        raise ValueError("--api-fixture must point to a JSON object")
    if key not in data:
        raise ValueError(f"--api-fixture is missing key: {key}")
    return data[key]


def api_data_from_tool(args: argparse.Namespace, key: str, tool_name: str, tool_args: dict[str, Any]) -> Any:
    fixture_value = api_fixture(args, key)
    if fixture_value is not None:
        return unwrap_data(fixture_value)
    result = call_plugin_tool(tool_name, tool_args)
    if not result.get("ok"):
        raise RuntimeError(f"{tool_name} failed: {json.dumps(result, ensure_ascii=False)}")
    return unwrap_data(result)


def unwrap_data(value: Any) -> Any:
    if isinstance(value, dict):
        response = value.get("response")
        if isinstance(response, dict):
            data = response.get("data")
            if data is not None:
                return data
            return response
        data = value.get("data")
        if data is not None:
            return data
    return value


def first_list(value: Any, keys: tuple[str, ...]) -> list[Any] | None:
    value = unwrap_data(value)
    if isinstance(value, list):
        return value
    if not isinstance(value, dict):
        return None
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, list):
            return candidate
    return None


def iter_nested_entries(value: Any) -> list[dict[str, Any]]:
    value = unwrap_data(value)
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if not isinstance(value, dict):
        return []

    for key in ("entries", "candidates", "codexEntries", "codex_entries"):
        candidate = value.get(key)
        if isinstance(candidate, list):
            return [item for item in candidate if isinstance(item, dict)]

    book = value.get("book")
    if isinstance(book, dict):
        found = iter_nested_entries(book)
        if found:
            return found

    entries: list[dict[str, Any]] = []
    for act in value.get("acts", []) or []:
        for chapter in act.get("chapters", []) or []:
            for scene in chapter.get("scenes", []) or []:
                if isinstance(scene, dict):
                    for item in scene.get("codexUsed", []) or []:
                        if isinstance(item, dict):
                            entries.append(item)
    if entries:
        return entries

    if any(key in value for key in ("entryName", "entry_name", "name")):
        return [value]
    return []


def entries_from_value(value: Any) -> list[Entry]:
    raw_entries = iter_nested_entries(value)
    entries: list[Entry] = []
    for raw in raw_entries:
        name = normalize_name(raw.get("entryName") or raw.get("entry_name") or raw.get("name"))
        if not name:
            continue
        entry_type = normalize_type(raw.get("entryType") or raw.get("entry_type") or raw.get("type"))
        description = normalize_description(
            raw.get("entryDescription") or raw.get("entry_description") or raw.get("description") or raw.get("excerpt")
        )
        entries.append(
            Entry(
                entry_type=entry_type,
                name=name,
                description=description,
                attributes=raw.get("attributes") if "attributes" in raw else raw.get("attributes_json"),
                entry_id=raw.get("id") or raw.get("codexId") or raw.get("codex_id"),
                raw=raw,
            )
        )
    return entries


def parse_entries(path_value: str) -> list[Entry]:
    return entries_from_value(load_any(path_value))


def scene_text(raw: dict[str, Any]) -> str:
    parts = [
        raw.get("title"),
        raw.get("chapterTitle"),
        raw.get("summary"),
        raw.get("outline"),
        raw.get("prose"),
        raw.get("text"),
        raw.get("content"),
    ]
    return "\n".join(str(part) for part in parts if part)


def parse_markdown_scenes(text: str) -> list[Scene]:
    scenes: list[Scene] = []
    current_title = "Document"
    current_lines: list[str] = []
    heading_re = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*$")
    for line in text.splitlines():
        match = heading_re.match(line)
        if match:
            if current_lines:
                scenes.append(Scene(label=current_title, text="\n".join(current_lines).strip()))
            current_title = match.group(1).strip()
            current_lines = []
        else:
            current_lines.append(line)
    if current_lines:
        scenes.append(Scene(label=current_title, text="\n".join(current_lines).strip()))
    return [scene for scene in scenes if scene.text]


def scenes_from_value(value: Any) -> list[Scene]:
    if isinstance(value, str):
        return parse_markdown_scenes(value)
    value = unwrap_data(value)
    raw_scenes = first_list(value, ("scenes", "items"))
    scenes: list[Scene] = []

    if raw_scenes is None and isinstance(value, dict):
        raw_scenes = []
        for act in value.get("acts", []) or []:
            for chapter in act.get("chapters", []) or []:
                for scene in chapter.get("scenes", []) or []:
                    if isinstance(scene, dict):
                        enriched = dict(scene)
                        enriched.setdefault("chapterTitle", chapter.get("title"))
                        raw_scenes.append(enriched)

    if raw_scenes is None and isinstance(value, dict):
        raw_scenes = [value]

    for index, raw in enumerate(raw_scenes or [], start=1):
        if not isinstance(raw, dict):
            continue
        label = normalize_name(raw.get("title") or raw.get("chapterTitle") or f"Scene {raw.get('id') or index}")
        text = scene_text(raw)
        if text.strip():
            scenes.append(Scene(label=label, text=text, scene_id=raw.get("id"), raw=raw))
    return scenes


def parse_scenes(path_value: str) -> list[Scene]:
    return scenes_from_value(load_any(path_value))


def token_set(text: str) -> set[str]:
    return {token.lower() for token in re.findall(r"[A-Za-z0-9']{3,}", text)}


def similarity(left: Entry, right: Entry) -> float:
    name_score = SequenceMatcher(None, left.name.lower(), right.name.lower()).ratio()
    left_tokens = token_set(f"{left.name} {left.description}")
    right_tokens = token_set(f"{right.name} {right.description}")
    overlap = len(left_tokens & right_tokens) / max(1, len(left_tokens | right_tokens))
    type_bonus = 0.1 if left.entry_type == right.entry_type else 0.0
    return min(1.0, (name_score * 0.72) + (overlap * 0.28) + type_bonus)


def best_match(entry: Entry, existing: list[Entry]) -> tuple[Entry | None, float]:
    best: Entry | None = None
    best_score = 0.0
    for candidate in existing:
        score = similarity(entry, candidate)
        if score > best_score:
            best = candidate
            best_score = score
    return best, best_score


def tool_call(tool: str, args: dict[str, Any]) -> dict[str, Any]:
    return {"tool": tool, "args": args}


def cmd_merge_plan(args: argparse.Namespace) -> dict[str, Any]:
    existing = parse_entries(args.existing)
    drafts = parse_entries(args.draft)
    return merge_plan(existing, drafts, args.book_id, args.threshold)


def merge_plan(existing: list[Entry], drafts: list[Entry], book_id: int | None, threshold: float) -> dict[str, Any]:
    actions = []
    for draft in drafts:
        match, score = best_match(draft, existing)
        if match and score >= threshold:
            action = {
                "action": "update_existing",
                "confidence": round(score, 3),
                "draft": draft.body(),
                "existing": match.body() | ({"id": match.entry_id} if match.entry_id else {}),
                "reason": "high name/description similarity",
            }
            if match.entry_id:
                action["toolCall"] = tool_call(
                    "proser_codex",
                    {"action": "update_entry", "codexId": match.entry_id, "body": draft.body()},
                )
        else:
            action = {
                "action": "create_new",
                "confidence": round(score, 3),
                "draft": draft.body(),
                "nearestExisting": match.body() | ({"id": match.entry_id} if match and match.entry_id else {}) if match else None,
            }
            if book_id is not None:
                action["toolCall"] = tool_call(
                    "proser_codex",
                    {"action": "create_entry", "bookId": book_id, "body": draft.body()},
                )
        actions.append(action)
    return {"ok": True, "draftCount": len(drafts), "existingCount": len(existing), "actions": actions}


def cmd_live_merge_plan(args: argparse.Namespace) -> dict[str, Any]:
    existing_data = api_data_from_tool(
        args,
        "codex",
        "proser_context",
        {"action": "codex_brief", "bookId": args.book_id, "query": {"pageSize": args.page_size}, "timeoutSeconds": args.timeout_seconds},
    )
    result = merge_plan(entries_from_value(existing_data), parse_entries(args.draft), args.book_id, args.threshold)
    result["bookId"] = args.book_id
    result["source"] = "fixture" if args.api_fixture else "live"
    return result


def infer_mention_type(name: str) -> str:
    lower = name.lower()
    if lower.startswith(("order of ", "guild of ", "house ", "the order", "the guild")):
        return "faction"
    if any(word in lower for word in ("bridge", "garden", "gate", "harbor", "house", "orchard", "room", "tower", "vault")):
        return "location"
    if any(word in lower for word in ("key", "mask", "mirror", "ring", "sword", "vial")):
        return "item"
    if lower.startswith(("the law", "law of ", "rule of ")):
        return "rule"
    return "lore" if name.lower().startswith("the ") else "character"


def context_snippet(text: str, start: int, end: int, radius: int = 90) -> str:
    left = max(0, start - radius)
    right = min(len(text), end + radius)
    if left > 0:
        previous_space = text.rfind(" ", 0, left)
        if previous_space >= 0:
            left = previous_space + 1
    if right < len(text):
        next_space = text.find(" ", right)
        if next_space >= 0:
            right = next_space
    return " ".join(text[left:right].split())


def entry_name_pattern(entries: list[Entry]) -> str:
    names = sorted({entry.name for entry in entries if entry.name}, key=len, reverse=True)
    return "|".join(re.escape(name) for name in names)


def clean_lower_alias(value: str) -> str:
    alias = " ".join(value.strip(" \t\r\n,.;:!?()[]{}\"'").split())
    alias = re.sub(r"\s+(?:who|that|which|while|when|where|because)\b.*$", "", alias, flags=re.IGNORECASE)
    alias = alias.strip(" \t\r\n,.;:!?()[]{}\"'")
    words = re.findall(r"[A-Za-z'-]+", alias.lower())
    if len(words) < 2 or len(words) > 6:
        return ""
    if words[0] not in {"a", "an", "the"}:
        return ""
    if not any(word in ALIAS_ROLE_WORDS for word in words[1:]):
        return ""
    if any(word in {"and", "or", "but"} for word in words):
        return ""
    return alias.lower()


def alias_candidates(text: str, existing: list[Entry], limit: int) -> list[dict[str, Any]]:
    name_re = entry_name_pattern(existing)
    if not name_re:
        return []

    entries_by_name = {entry.name.lower(): entry for entry in existing}
    alias_phrase = r"(?:a|an|the)\s+[a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,5}"
    patterns = [
        re.compile(rf"\b(?P<name>{name_re})\b\s*(?:,|--|-|\bis\b|\bwas\b|\bas\b)\s*(?P<alias>{alias_phrase})", re.IGNORECASE),
        re.compile(rf"\b(?P<alias>{alias_phrase})\s*,\s*(?P<name>{name_re})\b", re.IGNORECASE),
    ]

    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for pattern in patterns:
        for match in pattern.finditer(text):
            name = normalize_name(match.group("name"))
            entry = entries_by_name.get(name.lower())
            alias = clean_lower_alias(match.group("alias"))
            if not entry or not alias or alias == entry.name.lower():
                continue
            key = (entry.name.lower(), alias)
            item = grouped.setdefault(
                key,
                {
                    "entryId": entry.entry_id,
                    "entryName": entry.name,
                    "entryType": entry.entry_type,
                    "alias": alias,
                    "count": 0,
                    "reason": "non-capitalized appositive alias",
                    "contexts": [],
                    "suggestedAttributesPatch": {"aliases": [alias]},
                },
            )
            item["count"] += 1
            if len(item["contexts"]) < 3:
                item["contexts"].append(context_snippet(text, match.start(), match.end()))

    candidates = sorted(grouped.values(), key=lambda item: (-item["count"], item["entryName"], item["alias"]))
    return candidates[:limit]


def mention_candidates(text: str, existing_names: set[str], limit: int, min_count: int) -> list[dict[str, Any]]:
    counts: Counter[str] = Counter()
    contexts: dict[str, list[str]] = {}
    for match in CAPITALIZED_ENTITY_RE.finditer(text):
        name = " ".join(match.group(0).split())
        if len(name) < 3 or name.split()[0] in STOP_MENTION_HEADS:
            continue
        if name.lower() in existing_names:
            continue
        counts[name] += 1
        if len(contexts.setdefault(name, [])) < 3:
            contexts[name].append(context_snippet(text, match.start(), match.end()))
    candidates = []
    for name, count in counts.most_common():
        if count < min_count:
            continue
        candidates.append(
            {
                "name": name,
                "count": count,
                "suggestedEntryType": infer_mention_type(name),
                "contexts": contexts.get(name, []),
            }
        )
        if len(candidates) >= limit:
            break
    return candidates


def sentence_spans(text: str) -> list[tuple[int, int, str]]:
    spans = []
    for match in re.finditer(r"[^.!?\n]+(?:[.!?]|\n|$)", text):
        sentence = match.group(0).strip()
        if sentence:
            spans.append((match.start(), match.end(), sentence))
    return spans


def possible_character_names(text: str, existing: list[Entry]) -> list[str]:
    names: dict[str, str] = {}
    for entry in existing:
        if entry.entry_type == "character":
            names[entry.name.lower()] = entry.name
    for match in CAPITALIZED_ENTITY_RE.finditer(text):
        name = " ".join(match.group(0).split())
        if len(name) < 3 or name.split()[0] in STOP_MENTION_HEADS:
            continue
        if infer_mention_type(name) == "character":
            names.setdefault(name.lower(), name)
    return sorted(names.values(), key=len, reverse=True)


def sentence_name_matches(sentence: str, names: list[str]) -> list[dict[str, Any]]:
    if not names:
        return []
    name_re = "|".join(re.escape(name) for name in names)
    matches = []
    for match in re.finditer(rf"\b(?P<name>{name_re})\b", sentence, flags=re.IGNORECASE):
        canonical = next((name for name in names if name.lower() == match.group("name").lower()), match.group("name"))
        matches.append({"name": canonical, "start": match.start(), "end": match.end()})
    return matches


def latest_name_before(matches: list[dict[str, Any]], position: int, fallback: str | None) -> str | None:
    before = [item for item in matches if item["end"] <= position]
    if before:
        return before[-1]["name"]
    return fallback


def add_relationship_candidate(
    grouped: dict[tuple[str, str, str], dict[str, Any]],
    source: str | None,
    target: str | None,
    role: str,
    snippet: str,
    target_alias: str | None = None,
) -> None:
    source = normalize_name(source)
    target = normalize_name(target)
    role = role.lower().strip()
    target_alias = " ".join(str(target_alias or "").lower().split()) or None
    if not source or not role:
        return
    if target and source.lower() == target.lower():
        return
    target_key = target.lower() if target else target_alias
    if not target_key:
        return
    key = (source.lower(), target_key, role)
    item = grouped.setdefault(
        key,
        {
            "source": source,
            "target": target or None,
            "targetAlias": target_alias,
            "relationship": role,
            "count": 0,
            "reason": "pronoun-linked relationship phrase",
            "contexts": [],
        },
    )
    item["count"] += 1
    if len(item["contexts"]) < 3:
        item["contexts"].append(snippet)


def relationship_candidates(text: str, existing: list[Entry], limit: int) -> list[dict[str, Any]]:
    names = possible_character_names(text, existing)
    if not names:
        return []
    name_re = "|".join(re.escape(name) for name in names)
    grouped: dict[tuple[str, str, str], dict[str, Any]] = {}
    previous_character: str | None = None

    possessive_re = re.compile(rf"\b(?P<source>{name_re})'s\s+(?P<role>{RELATIONSHIP_ROLE_RE})\s*,?\s+(?P<target>{name_re})\b", re.IGNORECASE)
    pronoun_target_re = re.compile(rf"\b(?P<pronoun>his|her|their)\s+(?P<role>{RELATIONSHIP_ROLE_RE})\s*,?\s+(?P<target>{name_re})\b", re.IGNORECASE)
    target_pronoun_re = re.compile(rf"\b(?P<target>{name_re})\b\s*,\s*(?P<pronoun>his|her|their)\s+(?P<role>{RELATIONSHIP_ROLE_RE})\b", re.IGNORECASE)
    pronoun_alias_re = re.compile(
        rf"\b(?P<source>{name_re})\b[^.!?\n]{{0,120}}\b(?P<pronoun>his|her|their)\s+"
        rf"(?P<role>{RELATIONSHIP_ROLE_RE})\b(?!\s*,?\s+(?:{name_re})\b)",
        re.IGNORECASE,
    )

    for offset_start, offset_end, sentence in sentence_spans(text):
        matches = sentence_name_matches(sentence, names)
        snippet = context_snippet(text, offset_start, offset_end)

        for match in possessive_re.finditer(sentence):
            add_relationship_candidate(grouped, match.group("source"), match.group("target"), match.group("role"), snippet)

        for match in pronoun_target_re.finditer(sentence):
            source = latest_name_before(matches, match.start(), previous_character)
            add_relationship_candidate(grouped, source, match.group("target"), match.group("role"), snippet)

        for match in target_pronoun_re.finditer(sentence):
            source = latest_name_before(matches, match.start(), previous_character)
            add_relationship_candidate(grouped, source, match.group("target"), match.group("role"), snippet)

        for match in pronoun_alias_re.finditer(sentence):
            add_relationship_candidate(
                grouped,
                match.group("source"),
                None,
                match.group("role"),
                snippet,
                target_alias=f"{match.group('pronoun').lower()} {match.group('role').lower()}",
            )

        character_matches = [item["name"] for item in matches]
        if character_matches:
            previous_character = character_matches[-1]

    candidates = sorted(grouped.values(), key=lambda item: (-item["count"], item["source"], item.get("target") or item.get("targetAlias") or ""))
    return candidates[:limit]


def relationship_draft_entry(candidate: dict[str, Any]) -> dict[str, Any]:
    target = candidate.get("target") or candidate.get("targetAlias") or "unknown target"
    role = candidate.get("relationship") or "relationship"
    attrs = {
        "source": candidate.get("source"),
        "target": target,
        "relationship": role,
        "evidence": candidate.get("contexts", []),
    }
    return {
        "entryType": "relationship",
        "entryName": f"{candidate.get('source')} and {target} ({role})",
        "entryDescription": "Candidate relationship inferred from pronoun-linked phrasing. Review before saving.",
        "attributes": json.dumps(attrs, ensure_ascii=False, sort_keys=True),
    }


def cmd_extract_mentions(args: argparse.Namespace) -> dict[str, Any]:
    scenes = parse_scenes(args.source)
    existing = parse_entries(args.existing) if args.existing else []
    existing_names = {entry.name.lower() for entry in existing}
    all_text = "\n\n".join(scene.text for scene in scenes)
    candidates = mention_candidates(all_text, existing_names, args.limit, args.min_count)
    aliases = [] if args.no_aliases else alias_candidates(all_text, existing, args.limit)
    relationships = [] if args.no_relationships else relationship_candidates(all_text, existing, args.limit)
    mention_entries = [
        {
            "entryType": candidate["suggestedEntryType"],
            "entryName": candidate["name"],
            "entryDescription": f"Candidate extracted from manuscript mentions. Review before saving. Mention count: {candidate['count']}.",
        }
        for candidate in candidates
    ]
    relationship_entries = [relationship_draft_entry(candidate) for candidate in relationships]
    return {
        "ok": True,
        "sceneCount": len(scenes),
        "candidateCount": len(candidates),
        "aliasCandidateCount": len(aliases),
        "relationshipCandidateCount": len(relationships),
        "candidates": candidates,
        "aliasCandidates": aliases,
        "relationshipCandidates": relationships,
        "relationshipDraftEntries": relationship_entries,
        "draftEntries": mention_entries + relationship_entries,
    }


def parse_attrs(entry: Entry) -> dict[str, Any]:
    if isinstance(entry.attributes, dict):
        return entry.attributes
    if isinstance(entry.attributes, str):
        try:
            value = json.loads(entry.attributes)
        except json.JSONDecodeError:
            return {}
        return value if isinstance(value, dict) else {}
    return {}


def mermaid_id(name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_]+", "_", name).strip("_")
    if not slug:
        slug = "entry"
    if slug[0].isdigit():
        slug = f"n_{slug}"
    return slug[:48]


def graph_edges(entries: list[Entry]) -> list[dict[str, str]]:
    names = {entry.name.lower(): entry for entry in entries}
    edges: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()

    for entry in entries:
        attrs = parse_attrs(entry)
        if entry.entry_type == "relationship":
            source = normalize_name(attrs.get("source") or attrs.get("from"))
            target = normalize_name(attrs.get("target") or attrs.get("to"))
            label = normalize_name(attrs.get("relationship") or attrs.get("status") or entry.name)
            if source and target:
                key = (source, target, label)
                if key not in seen:
                    seen.add(key)
                    edges.append({"source": source, "target": target, "label": label or "related"})
        text = f"{entry.description} {normalize_attributes(entry.attributes) or ''}".lower()
        for name, target in names.items():
            if target.name == entry.name:
                continue
            if re.search(rf"\b{re.escape(name)}\b", text):
                key = (entry.name, target.name, "mentions")
                if key not in seen:
                    seen.add(key)
                    edges.append({"source": entry.name, "target": target.name, "label": "mentions"})
    return edges


def cmd_graph(args: argparse.Namespace) -> dict[str, Any]:
    entries = parse_entries(args.entries)
    edges = graph_edges(entries)
    node_names = {entry.name for entry in entries}
    edge_names = {edge["source"] for edge in edges} | {edge["target"] for edge in edges}
    inferred_nodes = sorted(edge_names - node_names)
    nodes = [{"id": entry.entry_id, "name": entry.name, "entryType": entry.entry_type} for entry in entries]
    nodes.extend({"id": None, "name": name, "entryType": "external"} for name in inferred_nodes if name not in node_names)
    mermaid_lines = ["graph TD"]
    for node in nodes:
        mermaid_lines.append(f'  {mermaid_id(node["name"])}["{node["name"]} ({node["entryType"]})"]')
    for edge in edges:
        mermaid_lines.append(f'  {mermaid_id(edge["source"])} -->|{edge["label"]}| {mermaid_id(edge["target"])}')
    return {"ok": True, "nodeCount": len(nodes), "edgeCount": len(edges), "nodes": nodes, "edges": edges, "mermaid": "\n".join(mermaid_lines)}


def cmd_preset(args: argparse.Namespace) -> dict[str, Any]:
    if args.entry_type == "all":
        return {"ok": True, "presets": PRESETS}
    entry_type = normalize_type(args.entry_type)
    return {"ok": True, "entryType": entry_type, "attributes": PRESETS[entry_type], "attributesJson": json.dumps(PRESETS[entry_type], sort_keys=True)}


def entry_mentions(scene: Scene, entries: list[Entry]) -> list[dict[str, Any]]:
    text = scene.text.lower()
    mentions = []
    for entry in entries:
        if re.search(rf"\b{re.escape(entry.name.lower())}\b", text):
            mentions.append({"id": entry.entry_id, "name": entry.name, "entryType": entry.entry_type})
    return mentions


def cmd_coverage(args: argparse.Namespace) -> dict[str, Any]:
    entries = parse_entries(args.entries)
    scenes = parse_scenes(args.scenes)
    return coverage_report(entries, scenes, args.min_anchors)


def coverage_report(entries: list[Entry], scenes: list[Scene], min_anchors: int) -> dict[str, Any]:
    scene_reports = []
    mentioned_names: set[str] = set()
    for scene in scenes:
        mentions = entry_mentions(scene, entries)
        mentioned_names.update(item["name"].lower() for item in mentions)
        scene_reports.append(
            {
                "sceneId": scene.scene_id,
                "scene": scene.label,
                "anchorCount": len(mentions),
                "anchors": mentions,
                "status": "ok" if len(mentions) >= min_anchors else "weak",
            }
        )
    uncovered = [
        {"id": entry.entry_id, "name": entry.name, "entryType": entry.entry_type}
        for entry in entries
        if entry.name.lower() not in mentioned_names
    ]
    return {
        "ok": True,
        "sceneCount": len(scenes),
        "entryCount": len(entries),
        "weakScenes": [scene for scene in scene_reports if scene["status"] == "weak"],
        "uncoveredEntries": uncovered,
        "scenes": scene_reports,
    }


def cmd_live_coverage(args: argparse.Namespace) -> dict[str, Any]:
    codex_data = api_data_from_tool(
        args,
        "codex",
        "proser_context",
        {"action": "codex_brief", "bookId": args.book_id, "query": {"pageSize": args.page_size}, "timeoutSeconds": args.timeout_seconds},
    )
    book_map_data = api_data_from_tool(
        args,
        "bookMap",
        "proser_context",
        {
            "action": "book_map",
            "bookId": args.book_id,
            "query": {"maxSummaryChars": args.max_summary_chars, "maxOutlineChars": args.max_outline_chars},
            "timeoutSeconds": args.timeout_seconds,
        },
    )
    result = coverage_report(entries_from_value(codex_data), scenes_from_value(book_map_data), args.min_anchors)
    result["bookId"] = args.book_id
    result["source"] = "fixture" if args.api_fixture else "live"
    return result


def cmd_dry_run_upload(args: argparse.Namespace) -> dict[str, Any]:
    merge_args = argparse.Namespace(existing=args.existing, draft=args.draft, threshold=args.threshold, book_id=args.book_id)
    plan = cmd_merge_plan(merge_args) if args.existing else {"actions": []}
    if not args.existing:
        drafts = parse_entries(args.draft)
        plan = {
            "ok": True,
            "draftCount": len(drafts),
            "existingCount": 0,
            "actions": [
                {
                    "action": "create_new",
                    "draft": draft.body(),
                    "toolCall": tool_call("proser_codex", {"action": "create_entry", "bookId": args.book_id, "body": draft.body()}),
                }
                for draft in drafts
            ],
        }
    steps = []
    for index, action in enumerate(plan["actions"], start=1):
        steps.append(
            {
                "step": index,
                "operation": action["action"],
                "entryName": action["draft"]["entryName"],
                "entryType": action["draft"]["entryType"],
                "toolCall": action.get("toolCall"),
            }
        )
    return {"ok": True, "bookId": args.book_id, "stepCount": len(steps), "steps": steps, "mergePlan": plan}


def plan_steps_from_value(value: Any) -> list[dict[str, Any]]:
    value = unwrap_data(value)
    if not isinstance(value, dict):
        raise ValueError("Upload plan must be a JSON object")
    if isinstance(value.get("steps"), list):
        return [step for step in value["steps"] if isinstance(step, dict)]
    merge = value.get("mergePlan") if isinstance(value.get("mergePlan"), dict) else value
    actions = merge.get("actions", []) if isinstance(merge, dict) else []
    steps = []
    for index, action in enumerate(actions, start=1):
        if not isinstance(action, dict):
            continue
        draft = action.get("draft") if isinstance(action.get("draft"), dict) else {}
        steps.append(
            {
                "step": index,
                "operation": action.get("action"),
                "entryName": draft.get("entryName"),
                "entryType": draft.get("entryType"),
                "toolCall": action.get("toolCall"),
            }
        )
    return steps


def cmd_upload_execute(args: argparse.Namespace) -> dict[str, Any]:
    steps = plan_steps_from_value(load_any(args.plan))
    if args.confirm != "EXECUTE":
        return {
            "ok": False,
            "error": "Refusing to mutate Proser codex without --confirm EXECUTE.",
            "stepCount": len(steps),
            "wouldExecute": steps,
        }

    executed = []
    for step in steps[: args.max_steps]:
        call = step.get("toolCall")
        if not isinstance(call, dict):
            executed.append({"step": step.get("step"), "ok": False, "error": "Missing toolCall"})
            continue
        if call.get("tool") != "proser_codex":
            executed.append({"step": step.get("step"), "ok": False, "error": f"Unsupported tool: {call.get('tool')}"})
            continue
        call_args = call.get("args")
        if not isinstance(call_args, dict):
            executed.append({"step": step.get("step"), "ok": False, "error": "Invalid toolCall args"})
            continue
        if call_args.get("action") not in {"create_entry", "update_entry"}:
            executed.append({"step": step.get("step"), "ok": False, "error": f"Unsupported codex action: {call_args.get('action')}"})
            continue
        result = call_plugin_tool("proser_codex", call_args)
        executed.append({"step": step.get("step"), "entryName": step.get("entryName"), "operation": step.get("operation"), "result": result})
        if not result.get("ok") and args.stop_on_error:
            break

    return {
        "ok": bool(executed) and all((item.get("result") or {}).get("ok", item.get("ok", False)) for item in executed),
        "executedCount": len(executed),
        "executed": executed,
    }


def cmd_rename_scout(args: argparse.Namespace) -> dict[str, Any]:
    old = args.old_name
    new = args.new_name
    impacts = []
    for path_value in args.source:
        path = Path(path_value)
        text = path.read_text(encoding="utf-8")
        line_hits = []
        for number, line in enumerate(text.splitlines(), start=1):
            if old.lower() in line.lower():
                line_hits.append({"line": number, "text": line.strip()[:240]})
        if line_hits:
            impacts.append({"path": str(path), "hitCount": len(line_hits), "hits": line_hits[: args.limit]})
    result: dict[str, Any] = {"ok": True, "oldName": old, "newName": new, "fileCount": len(args.source), "impacts": impacts}
    if args.codex_id and new:
        body = {"entryName": new}
        result["codexRenameCall"] = tool_call("proser_codex", {"action": "update_entry", "codexId": args.codex_id, "body": body})
    return result


def cmd_live_rename_scout(args: argparse.Namespace) -> dict[str, Any]:
    old = args.old_name
    new = args.new_name
    codex_data = api_data_from_tool(
        args,
        "codex",
        "proser_context",
        {"action": "codex_brief", "bookId": args.book_id, "query": {"pageSize": args.page_size}, "timeoutSeconds": args.timeout_seconds},
    )
    scene_hits_data = api_data_from_tool(
        args,
        "sceneHits",
        "proser_context",
        {
            "action": "search_scenes",
            "bookId": args.book_id,
            "query": {"q": old, "limit": args.limit, "contextChars": args.context_chars},
            "timeoutSeconds": args.timeout_seconds,
        },
    )
    if args.include_notes:
        notes_data = api_data_from_tool(
            args,
            "notes",
            "proser_books",
            {"action": "list_notes", "bookId": args.book_id, "query": {"pageSize": args.page_size}, "timeoutSeconds": args.timeout_seconds},
        )
    else:
        notes_data = {"notes": []}

    codex_impacts = []
    for entry in entries_from_value(codex_data):
        text = f"{entry.name}\n{entry.description}\n{normalize_attributes(entry.attributes) or ''}"
        if old.lower() in text.lower():
            codex_impacts.append({"id": entry.entry_id, "entryName": entry.name, "entryType": entry.entry_type})

    scene_hits = []
    scene_hits_value = unwrap_data(scene_hits_data)
    if isinstance(scene_hits_value, dict):
        for hit in scene_hits_value.get("hits", []) or []:
            if isinstance(hit, dict):
                scene_hits.append(hit)

    note_hits = []
    for note in first_list(notes_data, ("notes", "items")) or []:
        if not isinstance(note, dict):
            continue
        text = "\n".join(str(note.get(key) or "") for key in ("title", "content", "body", "text"))
        if old.lower() in text.lower():
            note_hits.append({"id": note.get("id"), "title": note.get("title"), "excerpt": " ".join(text.split())[:240]})

    result: dict[str, Any] = {
        "ok": True,
        "source": "fixture" if args.api_fixture else "live",
        "bookId": args.book_id,
        "oldName": old,
        "newName": new,
        "codexImpacts": codex_impacts,
        "sceneHits": scene_hits,
        "noteHits": note_hits,
    }
    if args.codex_id and new:
        result["codexRenameCall"] = tool_call("proser_codex", {"action": "update_entry", "codexId": args.codex_id, "body": {"entryName": new}})
    return result


def lint_entry(entry: Entry, min_description: int, max_description: int) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    description = entry.description.strip()
    words = re.findall(r"[A-Za-z']+", description.lower())
    vague = sorted(set(words) & VAGUE_WORDS)
    if len(description) < min_description:
        findings.append({"severity": "warning", "code": "short-description", "message": "Description may be too short for useful RAG context."})
    if len(description) > max_description:
        findings.append({"severity": "warning", "code": "long-description", "message": "Description may be too long for compact RAG use."})
    if vague:
        findings.append({"severity": "info", "code": "vague-words", "message": f"Vague words found: {', '.join(vague)}."})
    if entry.entry_type in {"character", "location", "faction", "item", "relationship"} and not normalize_attributes(entry.attributes):
        findings.append({"severity": "info", "code": "missing-attributes", "message": "Structured attributes would make this entry easier to reuse."})
    if description.endswith(("?", "!")):
        findings.append({"severity": "info", "code": "prose-tone", "message": "Description reads like prose or an open question; prefer durable canon facts."})
    return findings


def cmd_lint(args: argparse.Namespace) -> dict[str, Any]:
    entries = parse_entries(args.entries)
    reports = []
    for entry in entries:
        findings = lint_entry(entry, args.min_description, args.max_description)
        if findings or args.include_clean:
            reports.append({"id": entry.entry_id, "entryName": entry.name, "entryType": entry.entry_type, "findings": findings})
    return {"ok": True, "entryCount": len(entries), "findingCount": sum(len(report["findings"]) for report in reports), "entries": reports}


def parse_rename_map(values: list[str], file_value: str | None) -> dict[str, str]:
    mapping: dict[str, str] = {}
    if file_value:
        data = load_any(file_value)
        if isinstance(data, dict):
            mapping.update({str(key): str(value) for key, value in data.items()})
    for value in values:
        old, sep, new = value.partition("=")
        if sep and old.strip() and new.strip():
            mapping[old.strip()] = new.strip()
    return mapping


def cmd_import(args: argparse.Namespace) -> dict[str, Any]:
    source = parse_entries(args.source)
    existing = parse_entries(args.target_existing) if args.target_existing else []
    rename_map = parse_rename_map(args.rename, args.rename_file)
    mapped = []
    for entry in source:
        if args.type and entry.entry_type not in args.type:
            continue
        body = entry.body()
        if body["entryName"] in rename_map:
            body["entryName"] = rename_map[body["entryName"]]
        mapped.append(Entry(body["entryType"], body["entryName"], body.get("entryDescription", ""), body.get("attributes"), entry.entry_id, entry.raw))
    tmp_path = None
    try:
        if existing:
            tmp_path = Path(args.tmp_plan or "/tmp/proser-codex-import-draft.json")
            tmp_path.write_text(json.dumps({"entries": [entry.body() for entry in mapped]}, ensure_ascii=False), encoding="utf-8")
            merge_args = argparse.Namespace(existing=args.target_existing, draft=str(tmp_path), threshold=args.threshold, book_id=args.book_id)
            plan = cmd_merge_plan(merge_args)
        else:
            plan = {
                "actions": [
                    {
                        "action": "create_new",
                        "draft": entry.body(),
                        "toolCall": tool_call("proser_codex", {"action": "create_entry", "bookId": args.book_id, "body": entry.body()}),
                    }
                    for entry in mapped
                ]
            }
    finally:
        if tmp_path and not args.keep_tmp:
            tmp_path.unlink(missing_ok=True)
    return {"ok": True, "sourceCount": len(source), "mappedCount": len(mapped), "renameMap": rename_map, "plan": plan}


def prompt_for_entry(entry: Entry, style: str) -> str:
    attrs = parse_attrs(entry)
    details = []
    for key in ("appearance", "region", "sensory_signature", "symbols", "materials", "owner"):
        value = attrs.get(key)
        if value:
            details.append(f"{key.replace('_', ' ')}: {value}")
    detail_text = "; ".join(str(item) for item in details)
    base = f"{entry.name}, {entry.entry_type}. {entry.description}"
    if detail_text:
        base = f"{base} {detail_text}."
    style_text = style or "cinematic book illustration, coherent with the story bible"
    return " ".join(f"{base} {style_text}".split())[:1200]


def cmd_visual_prompts(args: argparse.Namespace) -> dict[str, Any]:
    entries = parse_entries(args.entries)
    allowed = set(args.type or ["character", "location", "item", "faction", "culture"])
    seeds = []
    for entry in entries:
        if entry.entry_type not in allowed:
            continue
        prompt = prompt_for_entry(entry, args.style)
        seeds.append(
            {
                "id": entry.entry_id,
                "entryName": entry.name,
                "entryType": entry.entry_type,
                "prompt": prompt,
                "suggestPromptCall": tool_call("proser_images", {"action": "suggest_prompt", "body": {"subject": prompt}}),
            }
        )
        if len(seeds) >= args.limit:
            break
    return {"ok": True, "seedCount": len(seeds), "seeds": seeds}


def print_result(result: dict[str, Any], compact: bool = False) -> None:
    print(json.dumps(result, ensure_ascii=False, indent=None if compact else 2, sort_keys=True, separators=(",", ":") if compact else None))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Proser codex planning workbench.")
    parser.add_argument("--compact", action="store_true", help="Emit compact JSON.")
    sub = parser.add_subparsers(dest="command", required=True)

    merge = sub.add_parser("merge-plan", help="Plan create/update actions by comparing draft entries to existing codex.")
    merge.add_argument("--existing", required=True)
    merge.add_argument("--draft", required=True)
    merge.add_argument("--book-id", type=int)
    merge.add_argument("--threshold", type=float, default=0.82)
    merge.set_defaults(func=cmd_merge_plan)

    live_merge = sub.add_parser("live-merge-plan", help="Fetch existing codex from Proser and plan draft create/update actions.")
    live_merge.add_argument("--book-id", required=True, type=int)
    live_merge.add_argument("--draft", required=True)
    live_merge.add_argument("--threshold", type=float, default=0.82)
    live_merge.add_argument("--page-size", type=int, default=100)
    live_merge.add_argument("--timeout-seconds", type=float, default=30)
    live_merge.add_argument("--api-fixture", help="Offline replay fixture with a codex key.")
    live_merge.set_defaults(func=cmd_live_merge_plan)

    mentions = sub.add_parser("extract-mentions", help="Extract possible codex candidates from scenes or manuscript text.")
    mentions.add_argument("--source", required=True)
    mentions.add_argument("--existing")
    mentions.add_argument("--limit", type=int, default=40)
    mentions.add_argument("--min-count", type=int, default=1)
    mentions.add_argument("--no-aliases", action="store_true", help="Disable non-capitalized alias candidates for known entries.")
    mentions.add_argument("--no-relationships", action="store_true", help="Disable pronoun-linked relationship candidates.")
    mentions.set_defaults(func=cmd_extract_mentions)

    graph = sub.add_parser("graph", help="Build relationship graph JSON and Mermaid from codex entries.")
    graph.add_argument("--entries", required=True)
    graph.set_defaults(func=cmd_graph)

    preset = sub.add_parser("preset", help="Emit attribute preset JSON for one entry type or all types.")
    preset.add_argument("--entry-type", required=True, choices=sorted(VALID_TYPES | {"all"}))
    preset.set_defaults(func=cmd_preset)

    coverage = sub.add_parser("coverage", help="Report scene-to-codex coverage and uncovered entries.")
    coverage.add_argument("--entries", required=True)
    coverage.add_argument("--scenes", required=True)
    coverage.add_argument("--min-anchors", type=int, default=1)
    coverage.set_defaults(func=cmd_coverage)

    live_coverage = sub.add_parser("live-coverage", help="Fetch Proser codex/book map and report scene-to-codex coverage.")
    live_coverage.add_argument("--book-id", required=True, type=int)
    live_coverage.add_argument("--min-anchors", type=int, default=1)
    live_coverage.add_argument("--page-size", type=int, default=100)
    live_coverage.add_argument("--max-summary-chars", type=int, default=600)
    live_coverage.add_argument("--max-outline-chars", type=int, default=600)
    live_coverage.add_argument("--timeout-seconds", type=float, default=30)
    live_coverage.add_argument("--api-fixture", help="Offline replay fixture with codex and bookMap keys.")
    live_coverage.set_defaults(func=cmd_live_coverage)

    dry = sub.add_parser("dry-run-upload", help="Turn draft entries into non-mutating upload steps.")
    dry.add_argument("--draft", required=True)
    dry.add_argument("--book-id", required=True, type=int)
    dry.add_argument("--existing")
    dry.add_argument("--threshold", type=float, default=0.82)
    dry.set_defaults(func=cmd_dry_run_upload)

    upload = sub.add_parser("upload-execute", help="Execute a dry-run upload plan through the Proser codex tool after explicit confirmation.")
    upload.add_argument("--plan", required=True, help="JSON output from dry-run-upload or merge-plan.")
    upload.add_argument("--confirm", default="", help="Must be exactly EXECUTE to mutate Proser.")
    upload.add_argument("--max-steps", type=int, default=200)
    upload.add_argument("--stop-on-error", action="store_true")
    upload.set_defaults(func=cmd_upload_execute)

    rename = sub.add_parser("rename-scout", help="Find old-name impacts before a codex rename.")
    rename.add_argument("--old-name", required=True)
    rename.add_argument("--new-name", default="")
    rename.add_argument("--codex-id", type=int)
    rename.add_argument("--source", action="append", required=True)
    rename.add_argument("--limit", type=int, default=20)
    rename.set_defaults(func=cmd_rename_scout)

    live_rename = sub.add_parser("live-rename-scout", help="Search live Proser codex, scene hits, and optional notes before a codex rename.")
    live_rename.add_argument("--book-id", required=True, type=int)
    live_rename.add_argument("--old-name", required=True)
    live_rename.add_argument("--new-name", default="")
    live_rename.add_argument("--codex-id", type=int)
    live_rename.add_argument("--limit", type=int, default=20)
    live_rename.add_argument("--context-chars", type=int, default=220)
    live_rename.add_argument("--page-size", type=int, default=100)
    live_rename.add_argument("--include-notes", action="store_true")
    live_rename.add_argument("--timeout-seconds", type=float, default=30)
    live_rename.add_argument("--api-fixture", help="Offline replay fixture with codex, sceneHits, and optional notes keys.")
    live_rename.set_defaults(func=cmd_live_rename_scout)

    lint = sub.add_parser("lint", help="Find vague, overlong, underspecified, or weak codex entries.")
    lint.add_argument("--entries", required=True)
    lint.add_argument("--min-description", type=int, default=80)
    lint.add_argument("--max-description", type=int, default=850)
    lint.add_argument("--include-clean", action="store_true")
    lint.set_defaults(func=cmd_lint)

    importer = sub.add_parser("import-plan", help="Map source codex entries into another book with rename and duplicate controls.")
    importer.add_argument("--source", required=True)
    importer.add_argument("--book-id", required=True, type=int)
    importer.add_argument("--target-existing")
    importer.add_argument("--rename", action="append", default=[], help="Old Name=New Name. Can be repeated.")
    importer.add_argument("--rename-file")
    importer.add_argument("--type", action="append", choices=sorted(VALID_TYPES))
    importer.add_argument("--threshold", type=float, default=0.82)
    importer.add_argument("--tmp-plan")
    importer.add_argument("--keep-tmp", action="store_true")
    importer.set_defaults(func=cmd_import)

    visual = sub.add_parser("visual-prompts", help="Derive proser_images prompt seeds from codex entries.")
    visual.add_argument("--entries", required=True)
    visual.add_argument("--type", action="append", choices=sorted(VALID_TYPES))
    visual.add_argument("--style", default="")
    visual.add_argument("--limit", type=int, default=50)
    visual.set_defaults(func=cmd_visual_prompts)

    return parser


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    compact_requested = "--compact" in argv
    argv = [item for item in argv if item != "--compact"]
    parser = build_parser()
    args = parser.parse_args(argv)
    args.compact = compact_requested or getattr(args, "compact", False)
    try:
        result = args.func(args)
    except Exception as exc:
        print_result({"ok": False, "error": str(exc)}, compact=getattr(args, "compact", False))
        return 2
    print_result(result, compact=args.compact)
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    raise SystemExit(main())
