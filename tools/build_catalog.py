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

A package with `channels` gets one of these sets of numbers per channel, because
they differ per build: 2.0.0 of BlueObject is twelve kilobytes bigger than 1.3.0
and depends on nothing where 1.3.0 depends on clibs. The entry's own top-level
fields stay, holding the release channel's answer -- so anything reading this
index without knowing about channels sees the published build, which is the safe
one to be wrong about.
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


def build_dir(directory, manifest, version):
    """Where a build's payloads live, relative to apps/.

    A package with one build keeps them beside its manifest, which is every
    package but one. A package with channels puts each build in its own
    directory, because two builds of the same package hold two different files
    called BLUE.8xp and neither may overwrite the other -- the whole point of
    keeping the old one is being able to go back to it.
    """
    named = manifest.get("builds", {}).get(version, {}).get("dir")
    if named:
        return directory / named
    if manifest.get("channels"):
        return directory / "builds" / version
    return directory


def resolve(manifest, version):
    """A build folded into its manifest, the way catalog.js does it."""
    build = manifest.get("builds", {}).get(version, {})
    return {**manifest, **build, "version": version}


def measure(directory, manifest, version):
    """The numbers the Store needs before it fetches anything: what a build
    weighs, its largest single file, and what it depends on."""
    resolved = resolve(manifest, version)
    files = build_dir(directory, manifest, version)

    total = 0
    largest = 0
    for action in resolved.get("actions", {}).get("install", []):
        if action.get("do") != "upload":
            continue
        payload = files / action["file"]
        if payload.is_file():
            size = body_size(payload)
            total += size
            largest = max(largest, size)

    return {
        "version": version,
        "bytes": total,
        # The largest single file, which is what decides installability: a
        # variable has to exist whole in RAM before it can be archived.
        "maxFile": largest,
        "deps": [d if isinstance(d, str) else d["id"]
                 for d in resolved.get("dependencies", [])],
    }


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

        channels = manifest.get("channels")
        if channels:
            if "release" not in channels:
                raise SystemExit(
                    f"{directory.name}: a package with channels needs a "
                    f"\"release\" one; that is what everybody else is served")
            published = channels["release"]
        else:
            published = manifest["version"]

        entry = {
            "id": manifest["id"],
            "dir": directory.name,
            "name": manifest.get("name", manifest["id"]),
            "kind": manifest.get("kind", "app"),
            "category": manifest.get("category", "tools"),
            **measure(directory, manifest, published),
            "summary": manifest.get("summary", manifest.get("description", "")),
        }

        if channels:
            # `files` is only ever carried when it differs from `dir`, so an
            # ordinary package's entry does not gain a field repeating itself.
            entry["channels"] = {}
            for name, version in channels.items():
                measured = measure(directory, manifest, version)
                measured["files"] = str(
                    build_dir(directory, manifest, version).relative_to(apps))
                entry["channels"][name] = measured
            entry["files"] = entry["channels"]["release"]["files"]

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
