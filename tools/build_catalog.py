#!/usr/bin/env python3
"""Generate apps/manifest.json from the per-app manifests.

The Store list and the Updates panel need a version, a category and a
dependency list for every package before they can draw anything. Fetching one
manifest per installed package on every connect would be thirty round-trips
before the page does anything useful, so those fields are copied into an index.

Copying invites drift, so nothing copies them by hand: this walks apps/*/ and
writes the index, byte sizes measured off the real payloads. It is derived, so
it cannot disagree with what it was derived from -- and CI runs this followed by
`git diff --exit-code apps/manifest.json`, which fails if somebody edited the
index instead of the manifests.
"""

import json
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

CATEGORIES = [
    {"id": "games", "name": "Games"},
    {"id": "graphics", "name": "Graphics"},
    {"id": "tools", "name": "Tools"},
    {"id": "libs", "name": "Libraries"},
    {"id": "system", "name": "System"},
]


def body_size(path):
    """The bytes the calculator will actually hold, not the file size.

    A .8xp is the variable plus a 55-byte wrapper and a checksum. Sizing the
    catalogue by file size would over-report every package by about 70 bytes and
    make the free-space arithmetic in front of an install quietly wrong.
    """
    data = path.read_bytes()
    if len(data) < 57:
        return len(data)
    section = struct.unpack("<H", data[53:55])[0]
    entry = data[55:55 + section]
    if len(entry) < 19 or struct.unpack("<H", entry[0:2])[0] != 13:
        return len(data)
    return struct.unpack("<H", entry[17:19])[0]


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 \
        else Path(__file__).resolve().parents[1]
    apps = root / "apps"

    entries = []
    for directory in sorted(p for p in apps.iterdir() if p.is_dir()):
        path = directory / "manifest.json"
        if not path.is_file():
            continue
        manifest = json.loads(path.read_text())

        total = 0
        largest = 0
        for action in manifest.get("actions", {}).get("install", []):
            if action.get("do") != "upload":
                continue
            payload = directory / action["file"]
            if payload.is_file():
                size = body_size(payload)
                total += size
                largest = max(largest, size)

        entry = {
            "id": manifest["id"],
            "dir": directory.name,
            "name": manifest.get("name", manifest["id"]),
            "kind": manifest.get("kind", "app"),
            "category": manifest.get("category", "tools"),
            "version": manifest["version"],
            "bytes": total,
            # The largest single file, which is what decides installability: a
            # variable has to exist whole in RAM before it can be archived.
            "maxFile": largest,
            "deps": [d if isinstance(d, str) else d["id"]
                     for d in manifest.get("dependencies", [])],
            "summary": manifest.get("summary", manifest.get("description", "")),
        }

        # Carried only when set, so the index does not gain a "disabled": false
        # on every package to say nothing. A disabled package stays in the index
        # rather than being left out of it: the Store will not offer it, but a
        # calculator that already has it installed still needs its version to
        # know whether an update exists, and its name to say what is installed.
        if manifest.get("disabled"):
            entry["disabled"] = True
        entries.append(entry)

    used = {e["category"] for e in entries}
    catalog = {
        "schema": 1,
        "revision": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "categories": [c for c in CATEGORIES if c["id"] in used],
        "apps": entries,
    }

    out = apps / "manifest.json"
    out.write_text(json.dumps(catalog, indent=2) + "\n")
    print(f"wrote {out.relative_to(root)} ({len(entries)} packages)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
