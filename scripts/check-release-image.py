"""Check application paths in every saved image layer and stage text for Gitleaks."""

import json
import re
import shutil
import sys
import tarfile
from pathlib import Path, PurePosixPath

PACKAGE_ROOT = PurePosixPath("opt/proser")
COMPONENTS = {"factory": "ProserFactory", "author": "ProserAuthor"}
PRIVATE_PARTS = {".auth", ".git", "certs", "exports", "imports"}
PRIVATE_EXTENSIONS = {".db", ".docx", ".dump", ".epub", ".har", ".key", ".p12", ".pem", ".pgcustom", ".sqlite", ".sqlite3"}
REQUIRED_ENV = {"NODE_ENV", "NEXT_TELEMETRY_DISABLED", "PLAYWRIGHT_BROWSERS_PATH", "PUBLICATION_FONT_MANIFEST"}


def inspect_layer(image, layer_name, destination):
    count = 0
    with tarfile.open(fileobj=image.extractfile(layer_name), mode="r|*") as layer:
        for item in layer:
            name = PurePosixPath(item.name)
            if not name.is_relative_to(PACKAGE_ROOT):
                continue
            path = name.relative_to(PACKAGE_ROOT)
            if not path.parts or path.parts[0] not in COMPONENTS:
                continue
            if ".." in path.parts:
                raise ValueError("Image contains an unsafe application layer path")
            if "node_modules" in path.parts:
                continue
            if (
                PRIVATE_PARTS.intersection(path.parts)
                or any(re.match(r"^(\.env($|\.)|\.npmrc$)", part) for part in path.parts)
                or path.suffix in PRIVATE_EXTENSIONS
                or (path.parts[:2] == ("factory", "data") and item.isfile())
                or (path.parts[:3] == ("factory", "public", "images") and item.isfile())
            ):
                raise ValueError("Image contains a private-file path in an application layer")
            if not item.isfile() or path.suffix not in {".js", ".cjs", ".mjs", ".ts", ".tsx", ".json", ".html"}:
                continue
            target = destination / COMPONENTS[path.parts[0]] / Path(*path.parts[1:])
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("wb") as output:
                shutil.copyfileobj(layer.extractfile(item), output)
            count += 1
    return count


def main():
    saved_image, stage = sys.argv[1:]
    with tarfile.open(saved_image) as image:
        [manifest] = json.load(image.extractfile("manifest.json"))
        config = json.load(image.extractfile(manifest["Config"]))["config"]
        allowed = {"PATH", "NODE_VERSION", "YARN_VERSION"} | REQUIRED_ENV
        names = {entry.split("=", 1)[0] for entry in config["Env"]}
        if not REQUIRED_ENV <= names <= allowed:
            raise ValueError("Unexpected application image environment metadata")
        # Scan each layer separately so a replacement or whiteout cannot hide earlier bytes.
        count = sum(
            inspect_layer(image, layer_name, Path(stage) / str(index))
            for index, layer_name in enumerate(manifest["Layers"])
        )
        if not count:
            raise ValueError("No application text files were found to scan")
    print(f"Checked application paths in every image layer and staged {count} text files.")


if __name__ == "__main__":
    main()
