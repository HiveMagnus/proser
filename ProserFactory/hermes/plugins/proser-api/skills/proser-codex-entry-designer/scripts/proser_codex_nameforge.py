#!/usr/bin/env python3
"""Generate deterministic codex-entry name candidates for Proser."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
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

SYLLABLES = {
    "fantasy": {
        "starts": ["Ae", "Ca", "El", "Is", "Ma", "Ny", "Or", "Sa", "Th", "Va"],
        "mids": ["lar", "mir", "ren", "sha", "the", "vel", "wyn", "zor"],
        "ends": ["a", "an", "el", "en", "ia", "is", "or", "yn"],
        "surnames": ["Ashvale", "Briar", "Duskryn", "Emberlain", "Moonhollow", "Thornweft"],
    },
    "gothic": {
        "starts": ["Al", "Cor", "Ed", "Len", "Mor", "Ros", "Sil", "Ver"],
        "mids": ["a", "en", "eth", "ian", "or", "wyn"],
        "ends": ["a", "e", "ine", "is", "or", "us"],
        "surnames": ["Blackfen", "Graves", "Harrow", "Lockmere", "Vale", "Wick"],
    },
    "science": {
        "starts": ["An", "Ira", "Kai", "Lin", "Mara", "Noa", "Rho", "Tala"],
        "mids": ["", "d", "n", "r", "s", "v"],
        "ends": ["", "a", "en", "i", "o", "us"],
        "surnames": ["Aster", "Calder", "Ion", "Nadir", "Quell", "Voss"],
    },
    "default": {
        "starts": ["Ada", "Bryn", "Cora", "Dane", "Eli", "Iris", "Mira", "Rowan"],
        "mids": [""],
        "ends": [""],
        "surnames": ["Bell", "Cairn", "Hale", "Morrow", "Reed", "Vale"],
    },
}

WORD_BANKS = {
    "adjectives": [
        "Amber",
        "Ashen",
        "Bright",
        "Broken",
        "Cinder",
        "Glass",
        "Hollow",
        "Iron",
        "Mirror",
        "Quiet",
        "Silver",
        "Verdant",
    ],
    "places": [
        "Archive",
        "Bridge",
        "Garden",
        "Gate",
        "Harbor",
        "Hollow",
        "House",
        "Market",
        "Orchard",
        "Sanctum",
        "Spire",
        "Vault",
    ],
    "collectives": [
        "Assembly",
        "Circle",
        "Compact",
        "Consortium",
        "Guild",
        "Order",
        "Pruners",
        "Syndicate",
        "Wardens",
    ],
    "objects": ["Bell", "Crown", "Key", "Lantern", "Mask", "Mirror", "Needle", "Seed", "Vial"],
    "abstracts": ["Accord", "Debt", "Edict", "Inheritance", "Oath", "Rite", "Schism", "Season", "Vigil"],
}


def normalize_type(value: str) -> str:
    normalized = value.strip().lower().replace("_", "-").replace(" ", "-")
    normalized = TYPE_ALIASES.get(normalized, normalized)
    if normalized not in VALID_TYPES:
        raise ValueError(f"Unsupported entry type '{value}'. Expected one of: {', '.join(sorted(VALID_TYPES))}")
    return normalized


def genre_key(genre: str) -> str:
    text = genre.lower()
    if any(word in text for word in ["gothic", "horror", "noir"]):
        return "gothic"
    if any(word in text for word in ["sci", "space", "cyber", "future", "speculative"]):
        return "science"
    if any(word in text for word in ["fantasy", "fae", "myth", "sword"]):
        return "fantasy"
    return "default"


def clean_words(text: str) -> list[str]:
    return [word.capitalize() for word in re.findall(r"[A-Za-z][A-Za-z'-]{1,}", text) if len(word) > 1]


def load_avoid_names(paths: list[str], inline: list[str]) -> set[str]:
    names = {name.strip().lower() for item in inline for name in item.split(",") if name.strip()}
    for path_value in paths:
        path = Path(path_value)
        if not path.exists():
            raise ValueError(f"Avoid file not found: {path}")
        raw = path.read_text(encoding="utf-8")
        try:
            parsed: Any = json.loads(raw)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            source = parsed.get("entries") or parsed.get("candidates") or []
        elif isinstance(parsed, list):
            source = parsed
        else:
            source = raw.splitlines()
        for item in source:
            if isinstance(item, dict):
                name = item.get("entryName") or item.get("name")
            else:
                name = str(item)
            if name and str(name).strip():
                names.add(str(name).strip().lower())
    return names


def rng_from_args(args: argparse.Namespace) -> random.Random:
    seed = args.seed or "|".join([args.entry_type, args.genre, args.tone, args.motif, args.salt])
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return random.Random(int(digest[:16], 16))


def pick(rng: random.Random, values: list[str]) -> str:
    return values[rng.randrange(len(values))]


def motif_word(rng: random.Random, motif_words: list[str], fallback: list[str]) -> str:
    if motif_words and rng.random() < 0.65:
        return pick(rng, motif_words)
    return pick(rng, fallback)


def character_name(rng: random.Random, genre: str, motif_words: list[str]) -> str:
    bank = SYLLABLES[genre_key(genre)]
    given = f"{pick(rng, bank['starts'])}{pick(rng, bank['mids'])}{pick(rng, bank['ends'])}"
    if motif_words and rng.random() < 0.35:
        surname = f"{pick(rng, motif_words)}{pick(rng, ['born', 'field', 'mere', 'vale', 'ward'])}"
    else:
        surname = pick(rng, bank["surnames"])
    return f"{given} {surname}"


def make_name(entry_type: str, rng: random.Random, genre: str, motif_words: list[str]) -> str:
    adjective = motif_word(rng, motif_words, WORD_BANKS["adjectives"])
    place = motif_word(rng, motif_words, WORD_BANKS["places"])
    abstract = motif_word(rng, motif_words, WORD_BANKS["abstracts"])

    if entry_type == "character":
        return character_name(rng, genre, motif_words)
    if entry_type == "location":
        pattern = rng.choice(["The {adj} {place}", "{adj} {place}", "{place} of {abs}"])
        return pattern.format(adj=adjective, place=place, abs=abstract)
    if entry_type == "faction":
        pattern = rng.choice(["The {adj} {group}", "{place} {group}", "Order of the {abs}"])
        return pattern.format(adj=adjective, place=place, group=pick(rng, WORD_BANKS["collectives"]), abs=abstract)
    if entry_type == "item":
        pattern = rng.choice(["{adj} {obj}", "{obj} of {abs}", "The {place} {obj}"])
        return pattern.format(adj=adjective, obj=pick(rng, WORD_BANKS["objects"]), abs=abstract, place=place)
    if entry_type == "event":
        return rng.choice([f"The {abstract} Night", f"The {adjective} Season", f"The Fall of {place}"])
    if entry_type == "rule":
        return rng.choice([f"The {abstract} Rule", f"The {adjective} Edict", f"The Law of {place}"])
    if entry_type == "culture":
        return rng.choice([f"{adjective} Rite", f"{place} Custom", f"The {abstract} Festival"])
    if entry_type == "relationship":
        return rng.choice([f"{adjective} Pact", f"The {abstract} Bond", f"{place} Alliance"])
    return rng.choice([f"The {adjective} {abstract}", f"{place} Lore", f"The {abstract} Record"])


def rationale(entry_type: str, name: str, motif: str, tone: str) -> str:
    parts = [f"Suggested {entry_type} name"]
    if motif:
        parts.append(f"motif: {motif}")
    if tone:
        parts.append(f"tone: {tone}")
    return f"{'; '.join(parts)}. Candidate: {name}."


def build_candidates(args: argparse.Namespace) -> list[dict[str, str]]:
    entry_type = normalize_type(args.entry_type)
    args.entry_type = entry_type
    motif_words = clean_words(args.motif)
    avoid = load_avoid_names(args.avoid_file, args.avoid)
    rng = rng_from_args(args)
    candidates: list[dict[str, str]] = []
    seen = set(avoid)
    attempts = max(args.count * 20, 40)

    for _ in range(attempts):
        name = make_name(entry_type, rng, args.genre, motif_words)
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        candidates.append(
            {
                "entryType": entry_type,
                "entryName": name,
                "rationale": rationale(entry_type, name, args.motif, args.tone),
            }
        )
        if len(candidates) >= args.count:
            break

    return candidates


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate Proser codex-entry name candidates.")
    parser.add_argument("--entry-type", required=True, help="Codex type, such as character, location, faction, or item.")
    parser.add_argument("--genre", default="", help="Genre hint, such as gothic fantasy or science fiction.")
    parser.add_argument("--tone", default="", help="Tone hint used in candidate rationales.")
    parser.add_argument("--motif", default="", help="Motif words to bias generated names.")
    parser.add_argument("--count", type=int, default=10, help="Number of candidates to return.")
    parser.add_argument("--seed", default="", help="Stable seed. Same inputs and seed produce the same candidates.")
    parser.add_argument("--salt", default="", help="Extra seed salt for a new deterministic batch.")
    parser.add_argument("--avoid", action="append", default=[], help="Comma-separated names to avoid. Can be repeated.")
    parser.add_argument("--avoid-file", action="append", default=[], help="Text or JSON file containing names to avoid.")
    parser.add_argument("--format", choices=["json", "lines"], default="json", help="Output format.")
    args = parser.parse_args()
    args.count = max(1, min(args.count, 100))

    try:
        candidates = build_candidates(args)
    except ValueError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, indent=2))
        return 2

    if args.format == "lines":
        for candidate in candidates:
            print(candidate["entryName"])
        return 0

    print(
        json.dumps(
            {
                "ok": True,
                "entryType": args.entry_type,
                "genre": args.genre,
                "tone": args.tone,
                "motif": args.motif,
                "count": len(candidates),
                "candidates": candidates,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
