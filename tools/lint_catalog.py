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

Every build of a package is checked, not just the published one. A package with
channels keeps its old builds so that a channel can point back at one, and a
historical build nobody has looked at in months is exactly the kind of thing
that quietly loses a file -- which would be discovered by whoever needed to roll
back to it, at the worst possible moment.
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


def builds_of(manifest, directory):
    """Every build a package declares, as (version, resolved manifest, files).

    A package with no channels has exactly one build -- itself, in its own
    directory -- which keeps every check below written once.
    """
    channels = manifest.get("channels")
    if not channels:
        return [(manifest.get("version"), manifest, directory)]

    out = []
    for version, build in (manifest.get("builds") or {}).items():
        named = build.get("dir")
        files = directory / named if named else directory / "builds" / version
        out.append((version, {**manifest, **build, "version": version}, files))
    return out


def check_channels(manifest, directory, problems):
    """Channels point at builds, and builds are what exist on disk."""
    channels = manifest.get("channels")
    package_id = manifest.get("id")

    if not channels:
        if manifest.get("builds"):
            problems.append(
                f"{package_id}: has \"builds\" but no \"channels\", so nothing "
                f"chooses between them")
        return

    if not isinstance(channels, dict) or not channels:
        problems.append(f"{package_id}: \"channels\" is a name-to-version object")
        return

    if "version" in manifest:
        # Two places saying which version this is, and they would drift the
        # first time one of them was edited alone.
        problems.append(
            f"{package_id}: has channels *and* a top-level \"version\"; the "
            f"channels decide the version, so remove it")

    if "release" not in channels:
        problems.append(
            f"{package_id}: no \"release\" channel; that is what anybody who "
            f"has not chosen otherwise is served")

    builds = manifest.get("builds") or {}
    for name, version in channels.items():
        if version not in builds:
            problems.append(
                f"{package_id}: channel \"{name}\" points at {version}, which "
                f"is not in \"builds\"")

    for version, build in builds.items():
        if not VERSION.match(str(version)):
            problems.append(
                f"{package_id}: build \"{version}\" is not x.y.z -- comparison "
                f"would have to guess")
        if "version" in build:
            problems.append(
                f"{package_id}: build {version} declares its own \"version\"; "
                f"the key it is filed under is the version")
        named = build.get("dir")
        files = directory / named if named else directory / "builds" / version
        if not files.is_dir():
            problems.append(
                f"{package_id}: build {version} has no {files.relative_to(directory.parent)}/")

    # A build nothing points at is not an error -- keeping history is the point
    # -- but one that no channel has ever served is worth saying out loud.
    return


def check_actions(manifest, directory, problems, uploads, warnings):
    actions = manifest.get("actions")
    if not isinstance(actions, dict):
        problems.append(f"{manifest['id']}: no \"actions\" object")
        return

    if not actions.get("install"):
        problems.append(f"{manifest['id']}: needs an \"actions.install\" list")

    where = manifest["id"]
    if manifest.get("channels"):
        where = f"{where} {manifest['version']}"

    for phase in ("install", "update", "uninstall"):
        entries = actions.get(phase)
        if entries is None:
            continue
        if not isinstance(entries, list):
            problems.append(f"{where}.{phase}: not a list")
            continue

        for i, action in enumerate(entries):
            at = f"{where}.{phase}[{i}]"
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


def library_names(manifests):
    """The C libraries, taken from the package that installs them."""
    entry = manifests.get("clibs")
    if not entry:
        return set()
    _, _, builds = entry
    names = set()
    for _, resolved, _ in builds:
        for action in resolved.get("actions", {}).get("install", []):
            if action.get("do") == "upload" and action.get("name"):
                names.add(action["name"])
    return names


def check_library_use(manifests, problems):
    """A package that calls into a C library has to say that it needs them.

    This used to be harmless to get wrong. BlueObject itself loaded five of the
    libraries, so clibs was on every calculator that could install anything at
    all, and a package that forgot to declare it worked anyway. BlueObject 2.0.0
    needs none of them, so a calculator can now be perfectly set up and have no
    libraries on it, and the package that forgot finds out by not starting.

    A program that uses one carries a record naming it -- 0xC0, the name, a NUL
    -- and that record survives in the file often enough to be worth looking
    for, including inside the compressed ones. Only the names the clibs package
    actually installs are looked for, so there is nothing to match by accident;
    across every package here it finds exactly the ones that do reference them
    and nothing else.

    Referencing a library is not the same as needing one. Cesium calls into
    USBDRVCE to read a USB drive and runs perfectly well without it -- so what
    this insists on is that the manifest has *said* which it is, in
    dependencies or in optionalDependencies. Nothing here can tell the two
    apart by looking; a person can, and this is what makes them.

    It can still miss. A name that falls inside a compressed run rather than a
    literal one will not be there to find, which is why KhiCAS -- whose payload
    is a flash application image -- went unnoticed until somebody installed it.
    So this catches a class of mistake rather than all of them, and a package
    that passes has not been proved innocent.

    The clibs package is skipped: its own libraries reference each other, which
    is what makes them libraries.
    """
    names = library_names(manifests)
    if not names:
        return

    patterns = {name: b"\xc0" + name.encode() + b"\x00" for name in names}

    for package_id, (_, _, builds) in sorted(manifests.items()):
        if package_id == "clibs":
            continue

        for version, resolved, files in builds:
            declared = {d if isinstance(d, str) else d.get("id")
                        for d in resolved.get("dependencies", [])
                        + resolved.get("optionalDependencies", [])}
            if "clibs" in declared:
                continue

            found = set()
            for action in resolved.get("actions", {}).get("install", []):
                if action.get("do") != "upload":
                    continue
                path = files / action["file"]
                if not path.is_file():
                    continue
                data = path.read_bytes()
                found |= {n for n, pattern in patterns.items() if pattern in data}

            if found:
                at = f"{package_id} {version}" if len(builds) > 1 else package_id
                problems.append(
                    f"{at}: calls into {', '.join(sorted(found))} but says "
                    f"nothing about clibs. Add it to \"dependencies\" if the "
                    f"package will not start without them, or to "
                    f"\"optionalDependencies\" with a \"reason\" if it only "
                    f"needs them for part of what it does")


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

        if not manifest.get("channels") \
                and not VERSION.match(str(manifest.get("version", ""))):
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

        check_channels(manifest, directory, problems)

        builds = builds_of(manifest, directory)
        for _, resolved, files in builds:
            uploads = []
            check_actions(resolved, files, problems, uploads, warnings)

        manifests[package_id] = (manifest, directory, builds)

    # Dependencies, once every package is known. Per build: what a package needs
    # is a property of the build, and 2.0.0 of BlueObject needs nothing where
    # 1.3.0 needs the C libraries.
    #
    # Optional ones are checked the same way and then left alone. They are never
    # installed for you -- that is the whole of what makes them optional -- but
    # naming a package that is not there is still a mistake, and one that would
    # otherwise only show as a blank on an app page.
    for package_id, (_, _, builds) in manifests.items():
        for version, resolved, _ in builds:
            at = f"{package_id} {version}" if len(builds) > 1 else package_id
            for field in ("dependencies", "optionalDependencies"):
                for dep in resolved.get(field, []):
                    dep_id = dep if isinstance(dep, str) else dep.get("id")
                    if dep_id not in manifests:
                        problems.append(f"{at}: {field} names \"{dep_id}\", "
                                        f"which is not in apps/")
                    elif dep_id == package_id:
                        problems.append(f"{at}: {field} names itself")

    # Cycles, which would hang a resolver that trusted the catalogue. Taken over
    # every build's dependencies together: a cycle that exists on any channel is
    # a cycle somebody can hit.
    graph = {}
    for pid, (_, _, builds) in manifests.items():
        edges = set()
        for _, resolved, _ in builds:
            for d in resolved.get("dependencies", []):
                edges.add(d if isinstance(d, str) else d.get("id"))
        graph[pid] = sorted(edges)
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

    check_library_use(manifests, problems)

    if problems:
        print(f"FAIL ({len(problems)}):")
        for problem in sorted(set(problems)):
            print(f"  {problem}")
        return 1

    builds = sum(len(b) for _, _, b in manifests.values())
    extra = f", {builds} builds" if builds != len(manifests) else ""
    print(f"ok: {len(manifests)} packages in apps/{extra} are well formed")
    for warning in sorted(set(warnings)):
        print(f"  note: {warning}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
