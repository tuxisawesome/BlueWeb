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
would offer somebody a downgrade.

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

## After changing anything

```sh
python3 tools/build_catalog.py    # regenerate apps/manifest.json
python3 tools/lint_catalog.py     # check every package
```

**`apps/manifest.json` is generated. Never edit it.** It exists so the Store and
Updates panels can render from one fetch instead of one per installed package,
and it is derived from the per-app manifests so that it cannot drift from them.

The linter is worth reading the output of rather than just the exit code. Its
most useful check compares each manifest's declared name and type against the
real 8x header of the file it points at — the file wins at install time, so a
disagreement means the manifest is describing something the package does not do,
and nothing at runtime would ever tell you.

It also refuses any single file over 32 KB. A TI variable has to exist whole in
RAM before it can be archived, and there is nowhere near 64 KB of that free on a
calculator with a program running, so a larger file cannot be installed at all.
Better to find that here than after the transfer.
