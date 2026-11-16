# Grok Bot sprites

Original pixel art generated entirely from code by `desktop/art/build-sprites.mjs`
(`npm run sprites` in `desktop/`, no dependencies). The same script also writes
`desktop/art/preview.png` (every frame of every state at 4×, on light and dark backgrounds, in
teal/orange/violet) and `desktop/art/icon-1024.png` (the app icon source). Hand-made art can
replace these files as long as it keeps the **same filenames and layout**.

## The character

A small helmet-headed robot: a dark rounded dome head with side ear caps, a dark visor band
with two glowing eyes, a ball-tipped antenna, a compact body with a chest light, floating
2×2 mitts (thin arms appear only when a hand is raised), and two small feet. A soft
low-alpha ground shadow sits under the feet and shrinks during hops.

- The shell is near-black with 3 tones: a lighter top-left plane, the base tone, and a darker
  bottom-right plane. A 1px rim light runs along the top-left edges.
- A 1px **outer outline** wraps the whole silhouette. It's two-tone: lighter on the top/left,
  darker on the bottom/right. It keeps the dark body readable on dark desktops, and the dark
  body reads on its own on light desktops. Seams where parts overlap are drawn in a dark grey.
- Eyes, the antenna tip and the chest light are on the accent layer. Each 2×3 eye has a soft
  1px glow ring (alpha ~80) and a single white highlight pixel in the base layer.
- The character sits 1px below its drawing grid, so hops of up to 3px never clip the antenna.

### Palette

| role                                    | hex                     |
| --------------------------------------- | ----------------------- |
| outline (top/left)                      | `#5b6478`               |
| outline (bottom/right)                  | `#474f61`               |
| rim light                               | `#3a4152`               |
| shell, lit plane                        | `#1c2029`               |
| shell, base                             | `#0f1115`               |
| shell, shaded plane                     | `#08090b`               |
| visor glass                             | `#040507`               |
| visor frame, seams                      | `#2a303c`               |
| eyes off (offline / error flicker)      | `#353b47`               |
| z's, wave ticks                         | `#8d96a8`               |
| smoke, laptop lid                       | `#aab1bf`               |
| laptop lid highlight                    | `#d5dbe6`               |
| error red (X eyes, antenna)             | `#ff4d4d`               |
| needs_you "!" sign                      | `#ffc83d`               |
| eye highlight, sparkle/orb cores        | `#ffffff`               |
| ground shadow                           | black at alpha 64 / 34  |
| **accent** (tinted per bot at runtime)  | white + alpha           |

## Layout

- Each state is a **horizontal strip** of 32×32 frames, left to right, no padding, RGBA PNG.
- The app draws frames at an **integer 3× scale** (2× when more than 3 bots are shown) with
  `image-rendering: pixelated` and canvas smoothing off. Don't anti-alias edges against a
  background colour: the window is transparent and sits on any desktop.

| state      | file                    | frames | fps | loop                       | animation |
| ---------- | ----------------------- | -----: | --: | -------------------------- | --------- |
| idle       | `grokbot_idle.png`      |      4 |   4 | yes                        | 1px breathing bob of head and hands, a blink on the third frame, antenna and chest light softly pulse |
| thinking   | `grokbot_thinking.png`  |      6 |   5 | yes                        | eyes glance up-right, one hand raised to the side of the head; an ellipsis appears one dot at a time above the head (newest dot pops up 1px), then fades |
| working    | `grokbot_working.png`   |      8 |  10 | yes                        | eyes down at a silver laptop (we see the lid back with a glowing accent logo); mitts on the deck alternate up/down, a key flashes under the pressing hand; slight head nod |
| juggling   | `grokbot_juggling.png`  |     10 |  12 | yes                        | three accent orbs on an elliptical loop: up from the left hand, over the head (in front of the antenna), down into the right hand, back behind the head. The left hand pops up on the toss and the right hand dips on the catch. Seamless loop: the orbs advance 240° over the strip |
| needs_you  | `grokbot_needs_you.png` |      6 |   8 | yes                        | crouch, hop of up to 3px, land; right hand waves overhead with motion ticks; a yellow "!" sign bobs top-left |
| done       | `grokbot_done.png`      |      8 |  10 | **play once**, then `idle` | crouch, jump with both arms up and happy ^ ^ eyes, sparkle bursts grow and fade around the bot, land with a squash. The last frame is exactly idle frame 0 for a seamless hand-off |
| error      | `grokbot_error.png`     |      6 |  10 | yes                        | 1px left/right shake, red X eyes (one flicker-off frame), antenna tip flashes red, grey smoke puffs rise from the head and dissipate. No accent |
| sleeping   | `grokbot_sleeping.png`  |      4 |   2 | yes                        | head slumped 1px, closed-eye arcs (dim accent), slow breathing bob, antenna tip and chest light dimmed; two grey z's rise, grow and fade, staggered |
| offline    | `grokbot_offline.png`   |      1 |   1 | yes                        | whole sprite desaturated, darkened and slightly translucent, eyes off, slumped, empty accent strip |

`manifest.json` is the source of truth the app reads (`file`, `accent`, `frames`, `fps`,
`loop`, `playOnce`, `then`, plus `frameWidth`/`frameHeight`/`scale`). If you change a frame
count or fps, update the manifest. The app needs no code change.

## Accent colour: separate accent layer

Every bot gets its own accent colour (Jarvis teal, Claude orange, Scout violet; other ids hash
into a fixed palette). The colour is applied with a **separate accent layer**, not by
recolouring palette entries:

- `grokbot_<state>.png`: the base layer, all non-accent pixels (body, outline, eye highlights,
  red error eyes, the "!" sign, smoke, z's, the laptop, and so on).
- `grokbot_<state>_accent.png`: same size and frame layout. **White pixels with alpha**
  mark where the accent goes. Alpha is the intensity: 255 for the eyes, the antenna tip, the
  laptop logo, orbs and sparkles; about 80 for the soft eye glow; about 115 for the antenna
  bulb rim; lower values for pulsing/dimmed lights (sleeping uses ~60 for the antenna tip).

At load time the app tints each accent strip with the bot's colour (canvas `source-in` fill)
and composites it over the base strip once per (state, colour). The result is cached and
drawn with nearest-neighbour scaling.

Rules for final art:

1. Keep the accent strip pure white (`#ffffff`) and encode intensity in alpha only.
2. Anything that must *not* change colour per bot (red error eyes and antenna, the yellow
   "!" sign, smoke, z's, white highlights) belongs in the base layer only. Where a white
   highlight sits inside an accent shape (eye highlight, orb and sparkle cores), the accent
   pixel there is left transparent so the white shows through.
3. The accent layer is drawn **on top** of the base layer. If an accent element should look
   like it passes behind the body (juggling orbs behind the head), leave those accent pixels
   transparent where the body covers them. The generator does this automatically: any opaque
   base pixel drawn later clears the accent underneath.
4. A state may omit its accent file (drop the `accent` key from the manifest). `offline` and
   `error` ship empty ones.
