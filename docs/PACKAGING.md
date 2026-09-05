# Adding an app to the store

A package is a directory under `apps/`, named after its id, holding a
`manifest.json` and the `.8xp`/`.8xv` files it installs.

```
apps/snake/
  manifest.json
  SNAKE.8xp
  SNAKEDAT.8xv
```

Commit the TI files exactly as you downloaded them. BlueWeb reads the variable's
name, type and archive flag out of the 8x header, so the file is the truth and
nothing has to be preprocessed — and the files stay usable with TI Connect CE.

## The manifest

```json
{
  "schema": 1,
  "id": "snake",
  "name": "Snake",
  "kind": "app",
  "category": "games",
  "version": "1.2.0",
  "summary": "The classic, on your calculator.",
  "description": "Longer prose for the app's page.",
  "author": "Somebody",
  "homepage": "https://…",
  "dependencies": [{ "id": "clibs", "version": ">=11.0.0" }],
  "actions": {
    "install": [
      { "do": "upload", "file": "SNAKE.8xp", "archive": true },
      { "do": "upload", "file": "SNAKEDAT.8xv", "archive": true }
    ]
  }
}
```

`id` must match the directory name. `version` must be `x.y.z`, because the
Updates panel orders versions rather than merely comparing them — otherwise a
package that had been rolled back would read as having an update, and the panel
would offer somebody a downgrade. (A package that publishes more than one build
declares `channels` instead of `version`; see below.)

`kind` is `app` or `system`. **A system package is one that needs the user to go
and run something on the calculator afterwards** — BlueObject needs `prgmBLUEUP`,
Cesium needs `prgmCESIUM`. That is the whole of the distinction, and it is what
splits the Updates panel in two.

## Actions

Three verbs, and no more:

| verb | what it does |
|---|---|
| `upload` | put a file from this directory onto the calculator |
| `remove` | delete a variable from the calculator |
| `message` | say something to the person doing this |

`upload` takes `file` and `archive`. `remove` takes `name` and `type`
(`program`, `protected program` or `appvar`). `message` takes `text`, `when`
(`pre` or `post`, default `post`) and `level` (`info` or `action`).

### The three lists

Only `install` is required. The others are derived from it unless you say
otherwise, so an ordinary app names each of its files exactly once:

- **`install`** — what the package consists of.
- **`update`** — defaults to `install`: re-upload everything, overwriting in place.
- **`uninstall`** — defaults to removing **what the calculator records this
  package as owning**, which is not the same as what this manifest uploads. An
  app installed by an older version whose file list has since changed still
  uninstalls completely, because the calculator is the authority on what is
  actually on it.

Override `update` when an upgrade should keep something:

```json
"update": [
  { "do": "upload", "file": "OIRAM.8xp", "archive": true },
  { "do": "message", "text": "Your level packs were kept." }
]
```

Override `uninstall` when removal needs saying as well as doing — which is what
Cesium needs, below.

## Cesium, and packages with a manual step

Cesium ships as `CESIUM.8xp`, which is an **installer**: it is an ordinary
program variable that BlueObject can write like any other, and *running* it is
what creates the Flash application under `[apps]`. So Cesium does not need
`BLUEUP` — it needs an upload and a message.

The reverse is not symmetrical, and the manifest has to say so. The Flash
application itself cannot be deleted over the link: the CE toolchain exposes no
API for it, and an undocumented flash write is not worth the risk of bricking
somebody's calculator. Uninstalling removes `prgmCESIUM` and tells the user how
to remove the app by hand.

```json
{
  "schema": 1,
  "id": "cesium",
  "name": "Cesium",
  "kind": "system",
  "category": "system",
  "version": "3.7.0",
  "dependencies": [],
  "actions": {
    "install": [
      { "do": "upload", "file": "cesium_english.zx0.8xp",
        "name": "CESIUM", "type": "prot_prgm", "archive": true },
      { "do": "message", "when": "post", "level": "action",
        "text": "Run prgmCESIUM once to finish installing Cesium. Quit BlueObject, press [prgm], choose CESIUM and press [enter]." }
    ],
    "uninstall": [
      { "do": "remove", "name": "CESIUM", "type": "prot_prgm" },
      { "do": "message", "when": "post", "level": "action",
        "text": "Cesium itself is a flash application and cannot be deleted over the cable, so remove it by hand: [2nd] [+], 2:Mem Mgmt/Del, Apps, cursor on Cesium, [del]." }
    ]
  }
}
```

Two details in there are worth copying rather than guessing at.

**The type is `prot_prgm`, not `program`.** The CE toolchain emits protected
programs, and most `.8xp` files you download are one. On an `upload` the linter
catches a wrong guess by reading the real 8x header — but a `remove` has no file
to check against, so a wrong type there would silently fail to delete anything:
the calculator would look for a plain program of that name and not find one.

**The version came out of the binary.** `strings` on the installer prints
`Cesium Installer Version 3.7.0`. Getting this wrong is not cosmetic — it is
what the Updates panel compares, so too low never offers a real update and too
high offers a phantom one for ever.

`update` is left out, so it falls back to `install` — which re-uploads and
re-shows the "run prgmCESIUM" message. That is exactly right for an upgrade.

Cesium is vendored in `apps/cesium/`. To move it to a new release, drop the new
`.8xp` in, update `version` from what the installer prints, and run the two
tools below.

## Channels: more than one build of a package

Almost every package has one build, and everything above describes it. One does
not: BlueObject is the program this store installs *through*, so a bad build of
it is not a bad app — it is a calculator this page can no longer reach, and the
way back is TI Connect and a cable. A new one wants trying on real hardware
before everybody gets it.

A package with channels replaces its `version` with a `channels` block and a
`builds` block, and puts each build's files in its own directory:

```
apps/blueobject/
  manifest.json
  builds/1.3.0/BLUE.8xp, BLUEUP.8xp
  builds/2.0.0/BLUE.8xp, BLUEUP.8xp
```

```json
{
  "id": "blueobject",
  "name": "BlueObject",
  "description": "What is true of every build.",

  "channels": {
    "release": "1.3.0",
    "development": "2.0.0"
  },

  "builds": {
    "2.0.0": {
      "dependencies": [],
      "description": "What is true of this one."
    },
    "1.3.0": {
      "dependencies": ["clibs"]
    }
  },

  "dependencies": [],
  "actions": { "install": [ … ] }
}
```

**A channel is a pointer to a build.** `release` is required: it is what anybody
who has not chosen otherwise is served, and what a browser that cannot remember
a choice falls back to. Choosing anything else is behind Developer options
(below), because a build nobody has vouched for is not something to offer a
reader who wandered into Settings.

**A build inherits the whole manifest and overrides what it names.** So the
name, the actions and the summary are written once. What a build almost always
overrides is `dependencies`, because that is the field that describes the build
rather than the package — BlueObject 2.0.0 needs nothing where 1.3.0 needs the C
libraries, and taking that from the wrong build installs the C libraries for a
version that does not use them.

**A build's key is its version.** It does not carry a `version` of its own, and
neither does the manifest: two places saying which version this is would drift
the first time one of them was edited alone. Its files come from
`builds/<version>/` unless it names a `dir`.

### Publishing, and going back

Publishing is moving one line:

```json
"channels": { "release": "2.0.0", "development": "2.0.0" }
```

then `python3 tools/build_catalog.py`. Nothing is copied, because the build is
already there — that is what staging it put in place.

Rolling back is the same line in the other direction. **Old builds are never
deleted**, which is the whole reason a channel points at a version rather than
at "the newest": a channel can be moved back to any build still listed, and it
takes effect on the next page load with nothing rebuilt.

Note what the Updates panel will and will not do with that. It offers only a
strictly *newer* version, so moving `release` back does not offer anybody a
downgrade — a calculator already holding the withdrawn build keeps it until a
higher version is published. That is deliberate: silently downgrading somebody's
app manager is worse than leaving it alone.

### BlueObject stages itself

`tools/stage_release.sh` in the BlueObject repository builds both programs,
writes them to `builds/$VERSION/`, registers the build and points
**development** at it. It never touches `release`. Staging a build is not
publishing it, and the two being separate acts is what the channel is for.

## Hiding a package

`"disabled": true` takes a package out of the Store's window without taking it
out of the catalogue. One already on a calculator keeps its name in the Device
panel and its version in Updates, and anything depending on it still resolves.
That is the whole difference between hiding a package and deleting `apps/<id>/`,
which orphans every calculator that already has it.

Hidden packages can still be reached, on purpose: tapping the catalogue line at
the foot of the Store twenty times turns on **Developer options**, which puts
them back in the window marked "Hidden" and adds a section at the foot of
Settings holding them and the build channel, with the switch to turn it all off
again. It is the gesture a phone uses for its developer options and it is there
for the same reason — some things can only be tested with a package that is not
for general consumption. KhiCAS, at 44 files and nearly three megabytes, is the
only one here big enough to make a calculator garbage collect.

## After changing anything

```sh
python3 tools/build_catalog.py    # regenerate apps/manifest.json
python3 tools/lint_catalog.py     # check every package
```

**`apps/manifest.json` is generated. Never edit it.** It exists so the Store and
Updates panels can render from one fetch instead of one per installed package,
and it is derived from the per-app manifests so that it cannot drift from them.

### Declaring `clibs`

**If a package is written in C or ICE, it needs `clibs`, and it has to say so.**
That used to be forgiving: BlueObject itself loaded five of the libraries, so
they were on every calculator that could install anything at all, and a package
that forgot to declare them worked anyway. BlueObject 2.0.0 needs none of them —
so a calculator can now be perfectly set up with no libraries on it, and a
package that forgot finds out by not starting.

The linter looks for the record a program carries naming each library it calls
into, and refuses a package that references one without depending on `clibs`.
It catches a class of this rather than all of it: a name that falls inside a
compressed run rather than a literal one is not there to find, which is how
KhiCAS went unnoticed until somebody installed it. Passing the check is not
proof.

The linter checks **every build of every package**, not just the published one.
A historical build nobody has looked at in months is exactly the sort of thing
that quietly loses a file, and that would be discovered by whoever needed to
roll back to it, at the worst possible moment.

The linter is worth reading the output of rather than just the exit code. Its
most useful check compares each manifest's declared name and type against the
real 8x header of the file it points at — the file wins at install time, so a
disagreement means the manifest is describing something the package does not do,
and nothing at runtime would ever tell you.

It also refuses any single file over 32 KB. A TI variable has to exist whole in
RAM before it can be archived, and there is nowhere near 64 KB of that free on a
calculator with a program running, so a larger file cannot be installed at all.
Better to find that here than after the transfer.
