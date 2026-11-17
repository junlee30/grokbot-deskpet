# Icon sources

Hand-authored SVG, original art (Apache-2.0 like the rest of this repo). These are the only
icon sources. The PNG, ICNS and ICO files in `desktop/src-tauri/icons/` are generated from
them by `scripts/build-icons.sh`, which uses the Tauri CLI's own SVG renderer. They are
committed so a fresh checkout builds without that step.

| file | what | output |
| ---- | ---- | ------ |
| `icon.svg` | App icon: a pup peeking over a desk. A 1024 canvas with the macOS 824 pt tile at (100, 100), radius 185. White pup, near-black tile, one accent (the orange desk `#ff8a3d`). | `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`, `icon.png`, `icon.icns`, `icon.ico` |
| `tray-template.svg` | Menu bar icon: the same pup simplified. **Black + alpha only** (a macOS template image). A 36-unit canvas = 18 pt @2x. | `tray-template.png` (18 px), `tray-template@2x.png` (36 px; the one the app loads) |

## Rules when editing

- Keep to a few large shapes. No strokes thinner than about 1/32 of the tile, and no baked-in
  highlights, shadows or glows: macOS adds its own.
- The silhouette has to say "pet" on its own (ears, paws), so the dark, tinted and template
  versions still read.
- Check 16 and 32 px before committing. Grok Bot's own art is never copied here.
