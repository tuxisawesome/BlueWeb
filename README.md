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

Connecting works and the Device panel is real. The Store, Updates and Settings
panels are scaffolding.

| | |
|---|---|
| ✅ | connecting, the link protocol, error messages worth reading |
| ✅ | the Device panel: model, OS, free space, largest installable file |
| ⬜ | the catalogue, app pages, search, dependencies |
| ⬜ | installing and removing |
| ⬜ | the Updates panel |
| ⬜ | the sync password |

## Running it

```sh
python3 -m http.server 8080
```

Then open <http://localhost:8080>.

**It has to be served, not opened as a file.** `fetch` of a relative path fails
from `file://`, so a double-clicked `index.html` would show an empty catalogue
and no reason why. The page detects that case and says so rather than looking
broken.

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
constant for constant, and that every module import resolves to a name that
actually exists. Neither runs the page — that needs a browser, and it is where
the real testing happens.
