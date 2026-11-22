// Every string Desk Pet shows, per language. Two kinds of text:
//   - the app's own UI (main window, menus, menu bar) follows the Mac's first preferred
//     language, the way Grok Bot picks its own (uiLocale);
//   - text about one bot (its tooltip, setup notes, its "needs you" notification) follows the
//     language that bot is using with you: the `lang` it sends with each post, or its
//     messages' script for bots that don't send one (petLocale).
// Status bubbles are the bot's own words and are shown as they are.
//
// To add a language: add it to LOCALES and give it a full `Strings` table (the type checker
// lists anything missing). Pure; unit-tested in test/i18n.test.ts.

export const LOCALES = ["en", "ko"] as const;
export type Locale = (typeof LOCALES)[number];

export interface Strings {
  // ---- main window
  settings: string;
  helloTitle: string;
  helloSub: string;
  connect: string;
  pairMode: (host: string) => string;
  needsDesktop: string;
  codeError: (msg: string) => string;
  pasteTitle: string;
  pairNote: string;
  cancel: string;
  close: string;
  done: string;
  copy: string;
  copied: string;
  copyAgain: string;
  pressCmdC: string;
  waitingFirst: string;
  waitingBots: string;
  waitingFirstSub: string;
  waitingSub: string;
  showCode: string;
  // ---- settings
  pairing: string;
  paired: (host: string | null, noBotYet: boolean) => string;
  notPaired: string;
  pairingNeedsDesktop: string;
  newCode: string;
  pair: string;
  unpair: string;
  sureUnpair: string;
  sureNewCode: string;
  skill: string;
  copySkillLink: string;
  skillCopied: string;
  mailbox: string;
  mailboxNote: string;
  petSize: string;
  large: string;
  small: string;
  alerts: string;
  notifyMe: string;
  pets: string;
  keepOnTop: string;
  keepOnTopNote: string;
  animateResting: string;
  updates: string;
  checkNow: string;
  checking: string;
  upToDate: string;
  updateFound: (v: string) => string;
  installRelaunch: string;
  /** `pct` is null when the download's size isn't known. */
  downloading: (pct: number | null) => string;
  installing: string;
  checkFailed: string;
  installFailed: string;
  tryAgain: string;
  positions: string;
  resetPositions: string;
  resetDoneSome: string;
  resetDoneNone: string;
  quit: string;
  save: string;
  version: (v: string) => string;
  // ---- connection status line
  connecting: (via: string) => string;
  connected: (via: string) => string;
  offline: (detail: string) => string;
  /** The Rust mailbox client's fixed status details (mailbox.rs), translated. */
  details: Record<string, string>;
  // ---- mailbox URL check (net.ts)
  urlInvalid: string;
  urlCredentials: string;
  urlQuery: string;
  urlHttps: string;
  urlScheme: string;
  urlTooLong: string;
  // ---- what the user pastes to a bot (the code must come last)
  pasteLine: (skillUrl: string, code: string) => string;
  // ---- menus (built in Rust from these)
  menuSettings: string;
  menuCheckUpdates: string;
  /** `{v}` = the new version. */
  menuUpdateTo: string;
  menuKeepOnTop: string;
  showHidden: string;
  hide: (name: string) => string;
  /** Menu bar tooltip when one bot needs you, and when several do (`{n}` = how many). */
  trayNeedsOne: string;
  trayNeedsMany: string;
  // ---- one bot's pet (in that bot's language)
  gearTitle: string;
  openInGrokBot: (name: string) => string;
  skillOutdatedSuffix: string;
  missedUpdates: (n: number) => string;
  outdatedNote: string;
  needsYouTitle: (name: string) => string;
  needsYouBody: string;
}

const en: Strings = {
  settings: "Settings",
  helloTitle: "Your Grok Bots, on your desk",
  helloSub: "Each bot gets a little pet that shows what it's up to. Click a pet to open its chat.",
  connect: "Connect your Grok Bot",
  pairMode: (host) => `Private, end-to-end encrypted · via ${host}`,
  needsDesktop: "The private mailbox needs the desktop app",
  codeError: (msg) => `Couldn't create a code: ${msg}`,
  pasteTitle: "Paste this to your Grok Bot",
  pairNote: "It works for any number of bots. The code is the key to your pets: share it only with your own bots.",
  cancel: "Cancel",
  close: "Close",
  done: "Done",
  copy: "Copy",
  copied: "Copied",
  copyAgain: "Copy again",
  pressCmdC: "Press ⌘C to copy",
  waitingFirst: "Waiting for your first bot…",
  waitingBots: "Waiting for your bots…",
  waitingFirstSub: "Paste the pairing message to a Grok Bot. Its pet pops up on your desk the moment it posts.",
  waitingSub: "Paired and listening. Each bot's pet pops up on your desk when it posts.",
  showCode: "Show code",
  pairing: "Pairing",
  paired: (host, noBotYet) => `Paired${host ? ` · ${host}` : ""}${noBotYet ? " · no bot yet" : ""}`,
  notPaired: "Not paired",
  pairingNeedsDesktop: "Pairing needs the desktop app",
  newCode: "New code",
  pair: "Pair",
  unpair: "Unpair",
  sureUnpair: "Sure? Unpair",
  sureNewCode: "Sure? Old code stops",
  skill: "Skill",
  copySkillLink: "Copy Skill Link",
  skillCopied: "Copied. Add it to your Grok Bot skill library, or send it to a bot to update its Desk Pet skill.",
  mailbox: "Mailbox",
  mailboxNote: "Used for the next new code.",
  petSize: "Pet size",
  large: "Large",
  small: "Small",
  alerts: "Alerts",
  notifyMe: "Notify me when a bot needs me",
  pets: "Pets",
  keepOnTop: "Keep on top of other windows",
  keepOnTopNote: "When not on top, pets stay behind your windows and come forward when a bot needs you.",
  animateResting: "Move while resting or asleep",
  updates: "Updates",
  checkNow: "Check Now",
  checking: "Checking…",
  upToDate: "Desk Pet is up to date.",
  updateFound: (v) => `Version ${v} is available.`,
  installRelaunch: "Install and Relaunch",
  downloading: (pct) => (pct === null ? "Downloading…" : `Downloading… ${pct}%`),
  installing: "Installing…",
  checkFailed: "Couldn't check for updates.",
  installFailed: "Couldn't install the update.",
  tryAgain: "Try Again",
  positions: "Positions",
  resetPositions: "Reset Pet Positions",
  resetDoneSome: "Done: lined up at the bottom right.",
  resetDoneNone: "Done: new bots start at the bottom right.",
  quit: "Quit Desk Pet",
  save: "Save",
  version: (v) => `Version ${v}`,
  connecting: (via) => `Connecting…${via}`,
  connected: (via) => `Connected${via}`,
  offline: (detail) => `Offline · ${detail}`,
  details: {
    retrying: "retrying",
    reconnecting: "reconnecting",
    "mailbox unreachable": "mailbox unreachable",
    "mailbox not responding": "mailbox not responding",
    "mailbox rate limit": "mailbox rate limit",
    "mailbox error": "mailbox error",
    "connection lost": "connection lost",
    "connection timed out": "connection timed out",
  },
  urlInvalid: "Not a valid URL",
  urlCredentials: "No credentials in the URL",
  urlQuery: "No query or fragment",
  urlHttps: "https is required (http only for localhost)",
  urlScheme: "Must be http(s)",
  urlTooLong: "URL too long",
  pasteLine: (url, code) => `Install the Desk Pet skill from ${url} and pair with code ${code}`,
  menuSettings: "Settings…",
  menuCheckUpdates: "Check for Updates…",
  menuUpdateTo: "Update to {v}…",
  menuKeepOnTop: "Keep Pets on Top",
  showHidden: "Show Hidden Pets",
  hide: (name) => `Hide ${name}`,
  trayNeedsOne: "Desk Pet · 1 bot needs you",
  trayNeedsMany: "Desk Pet · {n} bots need you",
  gearTitle: "Settings (or right-click the pet)",
  openInGrokBot: (name) => `Open ${name} in Grok Bot`,
  skillOutdatedSuffix: " · its Desk Pet skill is out of date",
  missedUpdates: (n) => `Missed ${n} update${n === 1 ? "" : "s"} (mailbox limit reached)`,
  outdatedNote: "My Desk Pet skill is out of date: ask me to update it",
  needsYouTitle: (name) => `${name} needs you`,
  needsYouBody: "Waiting for you in Grok Bot",
};

const ko: Strings = {
  settings: "설정",
  helloTitle: "내 Grok Bot들을 데스크톱에",
  helloSub: "봇마다 지금 무엇을 하는지 보여 주는 작은 펫이 생겨요. 펫을 클릭하면 그 봇과의 채팅이 열려요.",
  connect: "Grok Bot 연결하기",
  pairMode: (host) => `비공개 · 종단 간 암호화 · ${host} 경유`,
  needsDesktop: "비공개 메일박스는 데스크톱 앱에서만 쓸 수 있어요",
  codeError: (msg) => `코드를 만들지 못했어요: ${msg}`,
  pasteTitle: "이 메시지를 Grok Bot에게 붙여 넣으세요",
  pairNote: "봇이 몇 개든 이 코드 하나면 돼요. 코드는 펫의 열쇠예요. 내 봇에게만 알려 주세요.",
  cancel: "취소",
  close: "닫기",
  done: "완료",
  copy: "복사",
  copied: "복사됨",
  copyAgain: "다시 복사",
  pressCmdC: "⌘C를 눌러 복사하세요",
  waitingFirst: "첫 번째 봇을 기다리는 중…",
  waitingBots: "봇을 기다리는 중…",
  waitingFirstSub: "페어링 메시지를 Grok Bot에게 붙여 넣으세요. 봇이 상태를 보내는 순간 데스크톱에 펫이 나타나요.",
  waitingSub: "페어링되어 기다리는 중이에요. 봇이 상태를 보내면 데스크톱에 펫이 나타나요.",
  showCode: "코드 보기",
  pairing: "페어링",
  paired: (host, noBotYet) => `페어링됨${host ? ` · ${host}` : ""}${noBotYet ? " · 아직 봇 없음" : ""}`,
  notPaired: "페어링 안 됨",
  pairingNeedsDesktop: "페어링은 데스크톱 앱에서만 할 수 있어요",
  newCode: "새 코드",
  pair: "페어링",
  unpair: "페어링 해제",
  sureUnpair: "정말 해제할까요?",
  sureNewCode: "정말요? 기존 코드는 멈춰요",
  skill: "스킬",
  copySkillLink: "스킬 링크 복사",
  skillCopied: "복사했어요. Grok Bot 스킬 라이브러리에 추가하거나, 봇에게 보내 Desk Pet 스킬을 업데이트하게 하세요.",
  mailbox: "메일박스",
  mailboxNote: "다음에 만드는 새 코드부터 적용돼요.",
  petSize: "펫 크기",
  large: "크게",
  small: "작게",
  alerts: "알림",
  notifyMe: "봇이 나를 기다리면 알려 주기",
  pets: "펫",
  keepOnTop: "다른 창 위에 띄우기",
  keepOnTopNote: "위에 띄우지 않으면 펫이 창 뒤에 있다가, 봇이 나를 기다릴 때 앞으로 나와요.",
  animateResting: "쉬거나 잘 때도 움직이기",
  updates: "업데이트",
  checkNow: "지금 확인",
  checking: "확인하는 중…",
  upToDate: "최신 버전이에요.",
  updateFound: (v) => `새 버전이 있어요: ${v}`,
  installRelaunch: "설치 후 다시 열기",
  downloading: (pct) => (pct === null ? "내려받는 중…" : `내려받는 중… ${pct}%`),
  installing: "설치하는 중…",
  checkFailed: "업데이트를 확인하지 못했어요.",
  installFailed: "업데이트를 설치하지 못했어요.",
  tryAgain: "다시 시도",
  positions: "위치",
  resetPositions: "펫 위치 초기화",
  resetDoneSome: "완료: 오른쪽 아래에 나란히 놓았어요.",
  resetDoneNone: "완료: 새 봇은 오른쪽 아래에서 시작해요.",
  quit: "Desk Pet 종료",
  save: "저장",
  version: (v) => `버전 ${v}`,
  connecting: (via) => `연결 중…${via}`,
  connected: (via) => `연결됨${via}`,
  offline: (detail) => `오프라인 · ${detail}`,
  details: {
    retrying: "다시 시도하는 중",
    reconnecting: "다시 연결하는 중",
    "mailbox unreachable": "메일박스에 연결할 수 없음",
    "mailbox not responding": "메일박스가 응답하지 않음",
    "mailbox rate limit": "메일박스 사용 한도 도달",
    "mailbox error": "메일박스 오류",
    "connection lost": "연결이 끊김",
    "connection timed out": "연결 시간 초과",
  },
  urlInvalid: "올바른 URL이 아니에요",
  urlCredentials: "URL에 계정 정보를 넣을 수 없어요",
  urlQuery: "쿼리나 # 부분은 넣을 수 없어요",
  urlHttps: "https가 필요해요 (http는 localhost만)",
  urlScheme: "http(s) 주소여야 해요",
  urlTooLong: "URL이 너무 길어요",
  pasteLine: (url, code) => `${url} 에서 Desk Pet 스킬을 설치하고 이 코드로 페어링해 줘: ${code}`,
  menuSettings: "설정…",
  menuCheckUpdates: "업데이트 확인…",
  menuUpdateTo: "업데이트 {v} 설치…",
  menuKeepOnTop: "펫을 항상 위에",
  showHidden: "숨긴 펫 보기",
  hide: (name) => `${name} 숨기기`,
  trayNeedsOne: "Desk Pet · 봇 1개가 기다리는 중",
  trayNeedsMany: "Desk Pet · 봇 {n}개가 기다리는 중",
  gearTitle: "설정 (펫을 오른쪽 클릭해도 돼요)",
  openInGrokBot: (name) => `Grok Bot에서 ${name} 열기`,
  skillOutdatedSuffix: " · Desk Pet 스킬이 오래됐어요",
  missedUpdates: (n) => `업데이트 ${n}개를 놓쳤어요 (메일박스 한도 도달)`,
  outdatedNote: "제 Desk Pet 스킬이 오래됐어요. 업데이트해 달라고 말해 주세요",
  needsYouTitle: (name) => `${name}: 확인이 필요해요`,
  needsYouBody: "Grok Bot에서 기다리고 있어요",
};

const TABLES: Record<Locale, Strings> = { en, ko };

export function strings(locale: Locale): Strings {
  return TABLES[locale];
}

/** A supported locale for a BCP 47 tag ("ko-KR" → "ko"), or null. */
export function supported(tag: string | null | undefined): Locale | null {
  if (typeof tag !== "string") return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return (LOCALES as readonly string[]).includes(primary) ? (primary as Locale) : null;
}

/**
 * The app's UI language: the Mac's first preferred language if we have it, else English
 * (Grok Bot decides the same way from the same list).
 */
export function uiLocale(preferred: readonly string[]): Locale {
  return supported(preferred[0]) ?? "en";
}

/** A language from a message's script, for bots that don't send `lang` (Hangul → Korean). */
export function guessLocale(text: string | null | undefined): Locale | null {
  if (!text) return null;
  const hangul = (text.match(/[가-힣ᄀ-ᇿ㄰-㆏]/g) ?? []).length;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  return letters > 0 && hangul / letters >= 0.3 ? "ko" : null;
}

/**
 * One bot's language after an event: the `lang` it sent (a language we have no table for
 * falls back to the UI language), else its message's script, else what it had.
 */
export function petLocale(e: { lang?: unknown; message?: unknown }, current: Locale, ui: Locale): Locale {
  if (typeof e.lang === "string" && e.lang) return supported(e.lang) ?? ui;
  return guessLocale(typeof e.message === "string" ? e.message : null) ?? current;
}
