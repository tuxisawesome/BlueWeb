#!/usr/bin/env python3
"""Check every package in apps/ before it ships.

A bad manifest is not a crash. It is an app that installs a file under the wrong
name, or claims a dependency that is not there, or is too large to fit on any
calculator -- and each of those is discovered by whoever tries to install it,
after the transfer, on hardware. Everything here is cheap and catches it first.

The load-bearing check is that a manifest's declared name and type are compared
against the real 8x header of the file it points at. The file wins at install
time, so a disagreement here means the manifest is lying about what the package
does, and nothing at runtime would ever say so.
"""

import json
import re
import struct
import sys
from pathlib import Path

VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$")
# A capital first, then letters or digits of either case. The C libraries
# are deliberately mixed case -- LibLoad -- so all-caps would reject them.
TI_NAME = re.compile(r"^[A-Z][A-Za-z0-9]{0,7}$")
VERBS = {"upload", "remove", "message"}

TYPE_NAMES = {0x05: "program", 0x06: "protected program", 0x15: "appvar"}
TYPE_BY_NAME = {
    "program": 0x05, "prgm": 0x05,
    "protected program": 0x06, "prot_prgm": 0x06,
    "appvar": 0x15,
}

# "**TI83F*" and 0x1A 0x0A. The byte after those is usually 0x00 and is widely
# quoted as part of the signature, but it is not: Oiram's OiramPK.8xv ships with
# an 'O' there and is otherwise an ordinary variable file whose checksum
# validates. Insisting on the eleventh byte rejected a real release.
SIGNATURE = b"**TI83F*\x1a\x0a"

# A variable's length field is 16 bit, so nothing above this can exist on any
# calculator at all. This is the only size that is worth refusing outright.
SIZE_LIMIT = 65512

# Above this, a package may not install on a calculator that has much in RAM --
# a variable has to exist whole there before it can be archived. It is a warning
# and not a refusal, because how much RAM is free is a property of the
# calculator and not of the package: BlueWeb pre-flights every file against the
# figure the calculator actually reports, and says which one will not fit.
#
# This started life as a hard floor, which was a guess, and the guess was wrong
# the first time a real game hit it -- Oiram ships a 65 KB level pack that is
# perfectly installable on a calculator with room.
SIZE_WARN = 32 * 1024


def read_variable(data, where, problems):
    """The name, type and size inside a .8xp/.8xv, or None if it is not one."""
    if len(data) < 57 or data[:len(SIGNATURE)] != SIGNATURE:
        problems.append(f"{where}: not a TI variable file")
        return None

    section = struct.unpack("<H", data[53:55])[0]
    if 55 + section + 2 > len(data):
        problems.append(f"{where}: truncated")
        return None

    if sum(data[55:55 + section]) & 0xFFFF != \
            struct.unpack("<H", data[55 + section:57 + section])[0]:
        problems.append(f"{where}: checksum does not match; the file is damaged")
        return None

    entry = data[55:55 + section]
    if struct.unpack("<H", entry[0:2])[0] != 13:
        problems.append(f"{where}: unsupported variable entry header")
        return None

    name = entry[5:13].split(b"\0")[0].split(b" ")[0].decode("ascii", "replace")
    body_length = struct.unpack("<H", entry[17:19])[0]
    return {"name": name, "type": entry[4],
            "archived": bool(entry[14] & 0x80), "bytes": body_length}


def check_actions(manifest, directory, problems, uploads, warnings):
    actions = manifest.get("actions")
    if not isinstance(actions, dict):
        problems.append(f"{manifest['id']}: no \"actions\" object")
        return

    if not actions.get("install"):
        problems.append(f"{manifest['id']}: needs an \"actions.install\" list")

    for phase in ("install", "update", "uninstall"):
        entries = actions.get(phase)
        if entries is None:
            continue
        if not isinstance(entries, list):
            problems.append(f"{manifest['id']}.{phase}: not a list")
            continue

        for i, action in enumerate(entries):
            at = f"{manifest['id']}.{phase}[{i}]"
            verb = action.get("do")
            if verb not in VERBS:
                problems.append(f"{at}: \"{verb}\" is not one of {sorted(VERBS)}")
                continue

            if verb == "upload":
                name = action.get("file")
                if not isinstance(name, str) or not name:
                    problems.append(f"{at}: needs a \"file\"")
                    continue
                if ".." in name or name.startswith("/"):
                    problems.append(f"{at}: \"{name}\" escapes the package directory")
                    continue

                path = directory / name
                if not path.is_file():
                    problems.append(f"{at}: {name} is not in {directory.name}/")
                    continue

                info = read_variable(path.read_bytes(), at, problems)
                if not info:
                    continue
                uploads.append(info)

                if not TI_NAME.match(info["name"]):
                    problems.append(
                        f"{at}: {name} holds \"{info['name']}\", which the "
                        f"calculator will not accept as a name")
                if info["type"] not in TYPE_NAMES:
                    problems.append(
                        f"{at}: {name} is variable type "
                        f"0x{info['type']:02x}, which BlueObject cannot install")

                # The manifest may declare these; the file wins at install time,
                # so a disagreement means the manifest is describing something
                # the package does not actually do.
                if "name" in action and action["name"] != info["name"]:
                    problems.append(
                        f"{at}: declares name \"{action['name']}\" but {name} "
                        f"holds \"{info['name']}\"")
                if "type" in action:
                    declared = TYPE_BY_NAME.get(action["type"])
                    if declared != info["type"]:
                        problems.append(
                            f"{at}: declares type \"{action['type']}\" but {name} "
                            f"is {TYPE_NAMES.get(info['type'], 'unknown')}")

                if info["bytes"] > SIZE_LIMIT:
                    problems.append(
                        f"{at}: {name} is {info['bytes']} bytes, over the "
                        f"{SIZE_LIMIT}-byte limit a TI variable can ever be")
                elif info["bytes"] > SIZE_WARN:
                    warnings.append(
                        f"{at}: {name} is {info['bytes']} bytes. A variable has "
                        f"to fit in RAM before it can be archived, so this needs "
                        f"a calculator with little else in memory")

            elif verb == "remove":
                name = action.get("name")
                if not isinstance(name, str) or not TI_NAME.match(name or ""):
                    problems.append(f"{at}: \"{name}\" is not a valid TI name")
                # Required: there is no file here to read the type out of, and
                # guessing would mean looking for an appvar and quietly finding
                # nothing when the variable is a program.
                if action.get("type") not in TYPE_BY_NAME:
                    problems.append(
                        f"{at}: a \"remove\" needs a \"type\" "
                        f"(one of {', '.join(sorted(TYPE_BY_NAME))})")

            elif verb == "message":
                if not str(action.get("text", "")).strip():
                    problems.append(f"{at}: needs some \"text\"")
                if action.get("when", "post") not in ("pre", "post"):
                    problems.append(f"{at}: \"when\" is \"pre\" or \"post\"")
                if action.get("level", "info") not in ("info", "action"):
                    problems.append(f"{at}: \"level\" is \"info\" or \"action\"")


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 \
        else Path(__file__).resolve().parents[1]
    apps = root / "apps"

    problems = []
    warnings = []
    manifests = {}

    for directory in sorted(p for p in apps.iterdir() if p.is_dir()):
        path = directory / "manifest.json"
        if not path.is_file():
            problems.append(f"{directory.name}/: no manifest.json")
            continue
        try:
            manifest = json.loads(path.read_text())
        except json.JSONDecodeError as error:
            problems.append(f"{directory.name}/manifest.json: {error}")
            continue

        package_id = manifest.get("id")
        if not package_id:
            problems.append(f"{directory.name}/manifest.json: no id")
            continue
        if package_id != directory.name:
            problems.append(
                f"{directory.name}/: calls itself \"{package_id}\"; the "
                f"directory name is the id")
        if package_id in manifests:
            problems.append(f"{package_id}: two packages claim this id")

        if not VERSION.match(str(manifest.get("version", ""))):
            problems.append(
                f"{package_id}: version \"{manifest.get('version')}\" is not "
                f"x.y.z -- comparison would have to guess")
        if manifest.get("kind") not in ("app", "system"):
            problems.append(f"{package_id}: kind is \"app\" or \"system\"")
        if not manifest.get("name"):
            problems.append(f"{package_id}: no display name")
        # Anything but a real boolean. "false" is a string and a string is
        # truthy, so a typo here would hide a package from the Store and say
        # nothing about it anywhere.
        if "disabled" in manifest and not isinstance(manifest["disabled"], bool):
            problems.append(
                f"{package_id}: \"disabled\" is true or false, not "
                f"{json.dumps(manifest['disabled'])}")

        uploads = []
        check_actions(manifest, directory, problems, uploads, warnings)
        manifests[package_id] = (manifest, directory, uploads)

    # Dependencies, once every package is known.
    for package_id, (manifest, _, _) in manifests.items():
        for dep in manifest.get("dependencies", []):
            dep_id = dep if isinstance(dep, str) else dep.get("id")
            if dep_id not in manifests:
                problems.append(f"{package_id}: depends on \"{dep_id}\", "
                                f"which is not in apps/")
            elif dep_id == package_id:
                problems.append(f"{package_id}: depends on itself")

    # Cycles, which would hang a resolver that trusted the catalogue.
    graph = {pid: [d if isinstance(d, str) else d.get("id")
                   for d in m.get("dependencies", [])]
             for pid, (m, _, _) in manifests.items()}
    state = {}

    def walk(node, trail):
        if state.get(node) == "done":
            return
        if state.get(node) == "open":
            problems.append("dependency cycle: " + " -> ".join(trail + [node]))
            return
        state[node] = "open"
        for nxt in graph.get(node, []):
            if nxt in graph:
                walk(nxt, trail + [node])
        state[node] = "done"

    for package_id in graph:
        walk(package_id, [])

    if problems:
        print(f"FAIL ({len(problems)}):")
        for problem in sorted(set(problems)):
            print(f"  {problem}")
        return 1

    print(f"ok: {len(manifests)} packages in apps/ are well formed")
    for warning in sorted(set(warnings)):
        print(f"  note: {warning}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
