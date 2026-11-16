# Grok Bot sprites

Placeholder pixel art made by `desktop/art/build-sprites.mjs` (`npm run sprites` in `desktop/`).
Final art can replace these files as long as it keeps the **same filenames and layout**.

## Layout

- Each state is a **horizontal strip** of 32×32 frames, left to right, no padding, RGBA PNG.
- The app draws frames at an **integer 3× scale** (2× when more than 3 bots are shown) with
  `image-rendering: pixelated` and canvas smoothing off. Don't anti-alias edges against a
  background colour: the window is transparent and sits on any desktop.
- Body is near-black `#14161c` with a 1px lighter outline (`#4f5666`), so it reads on light
  and dark desktops.

| state      | file                    | frames | fps | loop                          |
| ---------- | ----------------------- | -----: | --: | ----------------------------- |
| idle       | `grokbot_idle.png`      |      4 |   3 | yes (breathing bob + blink)   |
| thinking   | `grokbot_thinking.png`  |      6 |   8 | yes (spark above head)        |
| working    | `grokbot_working.png`   |      8 |  10 | yes (typing)                  |
| juggling   | `grokbot_juggling.png`  |     10 |  12 | yes (two orbiting dots)       |
| needs_you  | `grokbot_needs_you.png` |      6 |   8 | yes (hop + flag)              |
| done       | `grokbot_done.png`      |      8 |  10 | **play once**, then `idle`    |
| error      | `grokbot_error.png`     |      6 |  12 | yes (shake, red eyes)         |
| sleeping   | `grokbot_sleeping.png`  |      4 |   2 | yes (eyes closed + Zz)        |
| offline    | `grokbot_offline.png`   |      1 |   1 | yes (dimmed, no accent)       |

`manifest.json` is the source of truth the app reads (`file`, `accent`, `frames`, `fps`,
`loop`, `playOnce`, `then`, plus `frameWidth`/`frameHeight`/`scale`). If you change a frame
count or fps, update the manifest. The app needs no code change.

## Accent colour: separate accent layer

Every bot gets its own accent colour (Jarvis teal, Claude orange, Scout violet; other ids hash
into a fixed palette). The colour is applied with a **separate accent layer**, not by
recolouring palette entries:

- `grokbot_<state>.png`: the base layer, all non-accent pixels (body, outline, red error
  eyes, flag, Zz, and so on).
- `grokbot_<state>_accent.png`: same size and frame layout. **White pixels with alpha**
  mark where the accent goes. Alpha is the intensity: 255 for eyes, the antenna tip and the
  chest light, about 70 for the soft eye glow.

At load time the app tints each accent strip with the bot's colour (canvas `source-in` fill)
and composites it over the base strip once per (state, colour). The result is cached and
drawn with nearest-neighbour scaling.

Rules for final art:

1. Keep the accent strip pure white (`#ffffff`) and encode intensity in alpha only.
2. Anything that must *not* change colour per bot (red error eyes, the yellow needs_you flag)
   belongs in the base layer only.
3. The accent layer is drawn **on top** of the base layer. If an accent element should look
   like it passes behind the body (the juggling dots), leave those accent pixels transparent
   where the body covers them.
4. A state may omit its accent file (drop the `accent` key from the manifest). `offline` ships
   an empty one.
