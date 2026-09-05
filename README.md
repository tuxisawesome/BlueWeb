# BlueWeb

The web store for [BlueObject][], and the app catalogue it serves.

Open it in Chrome, plug in a TI-84 Plus CE running BlueObject, and install apps
onto it over the cable. This repository is both halves of that: the page, and
the apps it offers.

[BlueObject]: https://github.com/tuxisawesome/BlueObject

- `js/` — the page. Plain ES modules, no build step, no npm.
- `apps/` — the catalogue. One directory per package.
- `apps/manifest.json` — the catalogue index. **Generated**; do not hand-edit.

## Where this is up to

Everything works against a real calculator: browsing, installing, updating,
removing, and the sync password.

| | |
|---|---|
| ✅ | connecting, the link protocol, error messages worth reading |
| ✅ | the Device panel: model, OS, free space, largest installable file |
| ✅ | the catalogue, the `BLUEIDX` index, versions, dependencies, action lists |
| ✅ | installing and removing, with pre-flight and recoverable interruptions |
| ✅ | the Store, app pages, search, the Updates panel, removal from Device |
| ✅ | the sync password |
| ✅ | ticking several apps in the Store and installing them in one go |
| ✅ | clearing several stray files at once from Device |
| ✅ | encrypted backup of the whole calculator, and restore |

All five panels work against a real calculator.

## Running it

```sh
python3 tools/serve.py
```

Then open <http://localhost:8080>.

Use that rather than `python3 -m http.server`, which sends no `Cache-Control`
at all. A browser given no instructions caches heuristically — roughly a tenth
of the file's age, so a page last edited three days ago is reused for the next
nine hours without even revalidating — and you spend the morning debugging an
edit the browser never fetched. `tools/serve.py` is the same server with
`no-store` on every response.

**It has to be served, not opened as a file.** `fetch` of a relative path fails
from `file://`, so a double-clicked `index.html` would show an empty catalogue
and no reason why. The page detects that case and says so rather than looking
broken.

## The sync password

Settings can put a password on a calculator, and BlueWeb asks for it whenever
that calculator is connected.

Be clear about what it is. It does not protect what is stored on the calculator
— anyone holding it can read its files from the calculator's own memory menu.
What it protects is the relationship between the calculator and a computer:
without it, nothing can be installed, removed or updated.

The way past it is to delete BlueObject's index, and that costs the entire
record of what is installed and which files belong to which app. That cost is
the deterrent, not secrecy.

The password itself never crosses the cable. The browser hashes it, the
calculator stores only the digest, and unlocking answers a fresh challenge each
time, so a recorded exchange cannot be replayed. The calculator counts wrong
answers and keeps the count across power cycles — it cannot rate-limit anybody,
since pulling the batteries would defeat that, but it can tell whoever does get
in how many there have been.

## Backups

Settings can write everything on a calculator — every program and appvar, and the
record of which app each one belongs to — into a single encrypted file, and put
it all back later.

Restoring erases first and writes second, in that order and deliberately. A
restore that merged would leave a calculator holding some of what the backup says
and some of whatever was there before, and no way to tell which was which.
BlueObject, its updater and its index are left alone: they are what is doing the
restoring, and the calculator keeps its own sync password whichever calculator the
backup came from.

The file is encrypted with the calculator's password, or with a passphrase you
choose if it has none. That is a different job from the sync password's. The sync
password protects a *relationship* — nothing can be installed or removed without
it — and it can afford to be a stored digest, because a guess has to be submitted
over a cable one at a time into a counter. A backup file is on a disk, where
whoever has it can guess as fast as their hardware allows, so the passphrase is
stretched into a key instead. **Lose it and the backup is gone**; there is no copy
of it anywhere, on the calculator or otherwise.

What is not in a backup: lists, matrices, strings and pictures, whose names are
tokenised rather than ASCII and do not fit the eight-byte name field the link
uses — the calculator cannot name them over the wire at all. Nor the password
hash, which never leaves the device.

## Requirements

**Chrome or Edge.** Web Serial does not exist in Firefox or Safari, and there is
no polyfill for talking to a USB device. The page says so plainly on the way in
rather than failing at the moment you press Connect.

On Linux your user usually needs to be in the `dialout` group to open a serial
port. That failure arrives as a bare `NetworkError` with no hint in it, so the
page translates it.

## Checks

The checks live in the BlueObject repository, because half of what they compare
is on that side:

```sh
../BlueObject/tools/hosttest/run_all.sh
```

They confirm `js/proto.js` still agrees with BlueObject's `calc/src/proto.h`
constant for constant, that `js/blueidx.js` agrees with two other
implementations of the index format, and that every module import resolves to a
name that actually exists.

None of them runs the page. That needs a browser, and it is where the real
testing happens:

```sh
python3 -m http.server 8080     # then open http://localhost:8080/tests.html
```

`tests.html` runs the real modules in the browser that runs the app. Its
fixtures are generated by BlueObject's `tools/blueidx.py`, which is a separate
implementation of the same formats — so a pass means two implementations agree,
rather than that one agrees with itself. The tab title reads `PASS` or
`FAIL <n>`.

## Adding an app

See [docs/PACKAGING.md](docs/PACKAGING.md). Short version: make a directory
under `apps/`, drop in the `.8xp` files as downloaded, write a `manifest.json`
with an `actions.install` list, then run `tools/build_catalog.py` and
`tools/lint_catalog.py`.
