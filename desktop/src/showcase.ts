// Dev-only showcase scene for README images and the GitHub social preview:
//   /showcase.html?mode=hero    1280×640 desktop with pets, a notification and the menu bar
//   /showcase.html?mode=social  1280×640 share card: title on the left, pets on the right
//   /showcase.html?mode=gif     the hero scene, looping a bot through thinking → working → done
// Jarvis wears Grok Bot's default avatar (blob/black), loaded from public/grokbot-art/
// (`npm run art`): the owner chose to show it, with a caption saying it is Grok Bot's art
// and not part of Desk Pet. Every other bot uses Desk Pet's original robot art. Not part of
// the build.
import { DEFAULTS, type DeskPetConfig } from "./config.ts";
import type { PetState, StateEvent } from "./events.ts";
import { layoutPets, petWindowSize } from "./layout.ts";
import { Pet } from "./pets.ts";
import { SpriteBank } from "./sprites.ts";
import { AvatarBank } from "./avatar-bank.ts";

type Mode = "hero" | "social" | "gif";
const mode: Mode = ((m) => (m === "social" || m === "gif" ? m : "hero"))(new URLSearchParams(location.search).get("mode"));

const W = 1280;
const H = 640;
const cfg: DeskPetConfig = { ...DEFAULTS, toastMs: 1e9 };
const bank = new SpriteBank();
/** Grok Bot's avatar art, for Jarvis only (see the header). */
const art = new AvatarBank();
const scene = document.getElementById("scene")!;
scene.style.width = `${W}px`;
scene.style.height = `${H}px`;

interface Bot {
  id: string;
  name: string;
  color: string;
  /** Draw this bot as its Grok Bot avatar (shape) instead of the robot. */
  shape?: string;
  x: number;
  y: number;
  lang?: string;
  pet?: Pet;
}

const { width: PW, height: PH } = petWindowSize("large");
/** Every pet on the scene (drawn every 32 ms). */
const allPets: Pet[] = [];
const ROW = H - PH - 18;

function el(html: string): HTMLElement {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
}

function menubar(waiting: number): void {
  scene.append(
    el(`<div class="menubar">
      <span class="tray"><img src="/icons-src/tray-template.svg" alt="" />${waiting || ""}</span>
      <span>Tue 9:41 AM</span>
    </div>`),
  );
}

function notification(x: number, y: number, title: string, body: string): void {
  const n = el(`<div class="note">
    <img src="/icons-src/icon.svg" alt="" />
    <div><span class="app">DESK PET · now</span><b></b><span class="body"></span></div>
  </div>`);
  n.style.left = `${x}px`;
  n.style.top = `${y}px`;
  n.querySelector("b")!.textContent = title;
  n.querySelector(".body")!.textContent = body;
  scene.append(n);
}

function terminal(x: number, y: number, w: number, h: number): void {
  const t = el(`<div class="terminal">
<div><span class="dim">~/projects/api</span> $ npm test</div>
<div class="dim">&gt; api@2.4.0 test</div>
<div>&nbsp;&nbsp;✓ parses the request body <span class="dim">(4 ms)</span></div>
<div>&nbsp;&nbsp;✓ rejects a bad token <span class="dim">(2 ms)</span></div>
<div>&nbsp;&nbsp;✓ retries on 429 <span class="dim">(31 ms)</span></div>
<div>&nbsp;&nbsp;✓ streams the response <span class="dim">(12 ms)</span></div>
<div class="ok">Tests: 87 passed, 87 total</div>
<div><span class="dim">~/projects/api</span> $ <span style="opacity:.8">▍</span></div>
  </div>`);
  Object.assign(t.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  scene.append(t);
}

function addPet(b: Bot): void {
  const win = document.createElement("div");
  win.className = "petwin";
  Object.assign(win.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${PW}px`, height: `${PH}px` });
  const stage = document.createElement("div");
  stage.className = "stage";
  win.append(stage);
  scene.append(win);
  const pet = new Pet(b.id, b.name, cfg, b.shape ? art : null); // null: Desk Pet's robot
  stage.append(pet.el, pet.bubble);
  pet.place(layoutPets(1, PW, PH, "large")[0] ?? null);
  b.pet = pet;
  allPets.push(pet);
}

/** Post an event to a bot's pet, `ago` ms in the past (old events don't toast). */
function post(b: Bot, state: PetState, message?: string, session = "s", ago = 0): void {
  const now = Date.now();
  const iso = new Date(now - ago).toISOString();
  const e: StateEvent = {
    agent_id: b.id,
    agent_name: b.name,
    session,
    state,
    event: "showcase",
    message,
    ts: iso,
    received_at: iso,
    avatar: { shape: b.shape ?? "blob", color: b.color }, // robots only use the colour
    lang: b.lang,
  };
  b.pet!.update(e, now, 1e9);
}

async function main(): Promise<void> {
  await Promise.all([bank.load(), art.load()]);
  if (!art.manifest) throw new Error("no Grok Bot art in public/grokbot-art: run `npm run art`");
  const right = (i: number) => W - 26 - PW - i * (PW - 6);
  // Grok Bot's default avatar: a black blob.
  const jarvis: Bot = { id: "jarvis", name: "Jarvis", color: "black", shape: "blob", x: right(0), y: ROW };
  const ruby: Bot = { id: "ruby", name: "루비", color: "red", x: right(1), y: ROW, lang: "ko" };
  const scout: Bot = { id: "scout", name: "Scout", color: "orange", x: right(2), y: ROW };
  const nova: Bot = { id: "nova", name: "Nova", color: "blue", x: right(3), y: ROW };
  const pip: Bot = { id: "pip", name: "Pip", color: "violet", x: right(4), y: ROW };

  if (mode === "social") {
    scene.append(
      el(`<div class="title" style="left:72px;top:150px">
        <h1><img src="/icons-src/icon.svg" alt="" />Desk Pet</h1>
        <p>A pixel-art pet on your desktop for each of your Grok Bots.</p>
        <p class="small">End-to-end encrypted · no server · macOS · unofficial</p>
      </div>`),
    );
    // Three pets, enlarged so they read at the size share cards are shown (CSS zoom keeps
    // the pixel art crisp: canvases are image-rendering: pixelated).
    const Z = 1.3;
    const row = document.createElement("div");
    Object.assign(row.style, { position: "absolute", right: "20px", bottom: "14px", width: `${3 * (PW - 4)}px`, height: `${PH}px`, zoom: String(Z) });
    scene.append(row);
    const bots = [
      { ...ruby, x: 0, y: 0 },
      { ...scout, x: PW - 4, y: 0 },
      { ...jarvis, x: 2 * (PW - 4), y: 0 },
    ];
    for (const b of bots) {
      addPet(b);
      row.append(scene.lastElementChild!); // addPet puts the window on the scene; move it into the row
    }
    post(bots[0], "thinking", "실패한 테스트를 읽는 중");
    post(bots[1], "needs_you", "Can I push to main?");
    post(bots[2], "working", "Running the test suite");
  } else {
    menubar(1);
    terminal(56, 70, 520, 168);
    notification(W - 26 - 340, 40, "Scout needs you", "Can I push to main?");
    [jarvis, ruby, scout, nova, pip].forEach(addPet);
    post(pip, "idle", undefined, "s", 10 * 60_000); // quiet for ten minutes: asleep
    post(scout, "needs_you", "Can I push to main?");
    post(nova, "working", "Refactoring the parser", "a");
    post(nova, "working", undefined, "b"); // two sessions at once: juggling
    post(ruby, "working", "테스트를 실행하는 중이에요");
    if (mode === "hero") {
      post(jarvis, "working", "Running the test suite");
    } else {
      // The GIF: Jarvis works through a turn, over and over (9 s).
      const loop = () => {
        post(jarvis, "thinking", "Reading the build log");
        setTimeout(() => post(jarvis, "working", "Running the test suite"), 2600);
        setTimeout(() => post(jarvis, "done", "All 87 tests pass"), 6000);
      };
      loop();
      setInterval(loop, 9000);
    }
  }
  setInterval(() => {
    const t = Date.now();
    for (const p of allPets) p.draw(bank, t, cfg, false);
  }, 32);
  document.body.dataset.ready = "1";
}

void main();
