// Languages: which one the UI and each pet use, and that every table is complete: `npm test`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { guessLocale, LOCALES, petLocale, strings, supported, uiLocale } from "../src/i18n.ts";
import { headerStatus, pasteLineV2, SKILL_URL } from "../src/connections.ts";
import { petNotice } from "../src/presence.ts";
import { validateMailboxUrl } from "../src/net.ts";

describe("which language", () => {
  it("the UI follows the Mac's first language if we have it, else English (as Grok Bot does)", () => {
    assert.equal(uiLocale(["ko-KR", "en-US"]), "ko");
    assert.equal(uiLocale(["en-US", "ko-US"]), "en", "this Mac: English first");
    assert.equal(uiLocale(["fr-FR", "ko-KR"]), "en", "first language only, like Grok Bot");
    assert.equal(uiLocale([]), "en");
    assert.equal(supported("ko_KR"), "ko");
    assert.equal(supported("kor"), null);
  });
  it("a pet follows its bot: lang first, then Hangul in the message, else what it had", () => {
    assert.equal(petLocale({ lang: "ko" }, "en", "en"), "ko");
    assert.equal(petLocale({ lang: "en-US", message: "테스트 실행 중" }, "ko", "ko"), "en", "lang wins over the script");
    assert.equal(petLocale({ lang: "ja" }, "ko", "en"), "en", "a language we don't have: the UI's");
    assert.equal(petLocale({ message: "테스트 실행 중" }, "en", "en"), "ko", "older bots: guessed from Hangul");
    assert.equal(petLocale({ message: "Running tests" }, "ko", "en"), "ko", "English text alone doesn't switch it back");
    assert.equal(petLocale({}, "ko", "en"), "ko");
    assert.equal(guessLocale("PR #42 리뷰 중"), "ko");
    assert.equal(guessLocale("Deploying to prod (배포)"), null, "mostly English");
    assert.equal(guessLocale("12345 ✓"), null);
  });
});

describe("tables", () => {
  it("every language has every string, none empty", () => {
    const keys = Object.keys(strings("en")).sort();
    for (const l of LOCALES) {
      const t = strings(l);
      assert.deepEqual(Object.keys(t).sort(), keys, l);
      for (const [k, v] of Object.entries(t)) {
        if (typeof v === "string") assert.ok(v.trim(), `${l}.${k}`);
        if (typeof v === "function") assert.ok(String(v.length ? v("X", "Y") : v()).trim(), `${l}.${k}`);
      }
      assert.deepEqual(Object.keys(t.details).sort(), Object.keys(strings("en").details).sort(), `${l}.details`);
      assert.ok(t.trayNeedsMany.includes("{n}"), `${l}.trayNeedsMany has {n}`);
    }
  });
  it("Korean in the places people see", () => {
    const ko = strings("ko");
    const line = pasteLineV2("dp2.CODE", ko);
    assert.ok(line.includes(SKILL_URL) && line.endsWith("dp2.CODE"), "link inside, code last");
    assert.equal(headerStatus({ paired: true, conn: { status: "offline", detail: "mailbox unreachable" }, host: "ntfy.sh" }, ko).text, "오프라인 · 메일박스에 연결할 수 없음");
    assert.equal(headerStatus({ paired: true, conn: { status: "offline", detail: "something new" }, host: "" }, ko).text, "오프라인 · something new", "unknown details pass through");
    assert.equal(petNotice({ dropped: 3 }, false, ko)?.text, "업데이트 3개를 놓쳤어요 (메일박스 한도 도달)");
    assert.equal(validateMailboxUrl("http://example.com", ko).ok ? "" : (validateMailboxUrl("http://example.com", ko) as { error: string }).error, "https가 필요해요 (http는 localhost만)");
    assert.equal(ko.needsYouTitle("Jarvis"), "Jarvis: 확인이 필요해요");
  });
  it("the status details match what the Rust mailbox client sends", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const rust = fs.readFileSync(path.join(here, "..", "src-tauri", "src", "mailbox.rs"), "utf8");
    const sent = new Set([...rust.matchAll(/detail: (?:Some\()?"([a-z ]+)"/g), ...rust.matchAll(/then_some\("([a-z ]+)"\)/g)].map((m) => m[1]));
    assert.ok(sent.size >= 6, [...sent].join(", "));
    for (const d of sent) assert.ok(d in strings("ko").details, `missing translation for "${d}"`);
  });
});
