# Vocab Notebook (单词本) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an English-learning vocab notebook to YouTube Digest: selection card (lookup + save), bilingual sentence cross-highlight, re-appearance highlight, vocab tab with mastery/listen-back/speak/export, and a cloze quiz.

**Architecture:** New pure module `vocab.js` (settings.js dual-import pattern: browser global + CommonJS + `importScripts` in the service worker) holds all testable logic. `background.js` gains 5 message routes (4 storage + 1 AI dictionary lookup). `sidepanel.js` gains the refactored selection card, vocab tab, highlight engine hooked into the existing render pipeline, speak, export, quiz. No changes to manifest, content.js, options.

**Tech Stack:** Vanilla JS (MV3 Chrome extension), `chrome.storage.local`, `chrome.runtime.sendMessage`, Web Speech API, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-23-vocab-notebook-design.md`

## Global Constraints

- No new manifest permissions; `content.js`, `manifest.json`, `options.html/js`, `settings.js` unchanged.
- Test runner: `node --test tests/*.test.js` (npm test). New tests import `../vocab.js` via `require`, mirroring `tests/settings.test.js`.
- Shared module pattern: `var YTD_VOCAB = (() => {...})();` + `if (typeof module !== "undefined" && module.exports) module.exports = YTD_VOCAB;`
- Background loads it via `importScripts("vocab.js");` next to the existing `importScripts("settings.js");` at `background.js:16`.
- Existing tests must stay green (`npm test`).
- UI copy is Simplified Chinese for user-facing vocab features (单词本/收藏到单词本/自测…), consistent with the 中文 display mode already shipped.
- Mastery levels exactly: `"new" | "fuzzy" | "known"` with labels 未掌握/模糊/已掌握.
- Storage key exactly `ytd_vocab`; cap 2000 entries.
- Selection card keeps the existing DOM contract: container `id="explainTooltip"` + class `explain-tooltip`, buttons `.explain-btn` and `.selection-note-btn` remain (existing `tests/transcript-selection.test.js` asserts them).

## Review Focus

1. **CJK selections** — selecting Chinese text in bilingual mode must save with `language:"zh"`, and phrase matching must use plain substring (no `\b`) for CJK. Pinned in Task 1 (index tests) and Task 6 (card test).
2. **"Waiting for translation…" leaking into saved context** — ZH context must come from `transcriptParagraphCache`, never the placeholder span text. Pinned in Task 6 (card test asserts cache lookup).
3. **Highlight/search mark nesting** — both walkers must skip nodes inside any `mark`; vocab clear must not unwrap search marks. Pinned in Task 8 (wiring test asserts mark-skip in walker filter).
4. **Double-click save spam** — duplicate `text+language` must not create a second entry. Pinned in Task 2 (applyVocabSave dedup test).
5. **Stale async meaning overwriting a newer selection's card** — lookup responses carry a generation counter. Pinned in Task 6 (source test asserts generation guard).

---

### Task 1: `vocab.js` — entry model + matching engine

**Files:**
- Create: `vocab.js`
- Test: `tests/vocab-index.test.js`

**Interfaces:**
- Produces: `YTD_VOCAB.normalizeWhitespace(text)→string`, `hasCJK(text)→bool`, `isSingleWord(text)→bool`, `normalizeVocabEntry(input)→entry`, `shouldHighlightEntry(entry,{highlightKnown})→bool`, `buildVocabIndex(entries,{highlightKnown})→{words:{en:Map,zh:Map},phrases:{en:[],zh:[]},highlightKnown}`, `findVocabMatches(text,index,language)→[{start,end,entryId}]`, constants `MASTERY_LEVELS`, `MASTERY_LABELS`, `ENTRY_CAP`.

- [ ] **Step 1: Write the failing tests**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const vocab = require("../vocab.js");

test("normalizeVocabEntry fills defaults and clamps fields", () => {
  const entry = vocab.normalizeVocabEntry({ text: "  Machine   Learning ", language: "zh", timestampSeconds: "12.9", mastery: "weird" });
  assert.equal(entry.text, "Machine Learning");
  assert.equal(entry.language, "zh");
  assert.equal(entry.timestampSeconds, 0); // non-finite string clamps
  assert.equal(entry.mastery, "new");
  assert.equal(entry.id.length > 0, true);
  const explicit = vocab.normalizeVocabEntry({ id: "x", text: "a", language: "de" });
  assert.equal(explicit.language, "en");
});

test("single word matches only whole words, case-insensitive", () => {
  const idx = vocab.buildVocabIndex([{ id: "e1", text: "run", language: "en" }]);
  const hits = (s) => vocab.findVocabMatches(s, idx, "en").map((m) => s.slice(m.start, m.end));
  assert.deepEqual(hits("He runs fast"), []);          // runs ≠ run
  assert.deepEqual(hits("Run it"), ["Run"]);            // case-insensitive
  assert.deepEqual(hits("a runner, run!"), ["run"]);    // boundary works
});

test("phrase matches flexibly across whitespace with word boundaries", () => {
  const idx = vocab.buildVocabIndex([{ id: "e2", text: "machine learning", language: "en" }]);
  const hits = (s) => vocab.findVocabMatches(s, idx, "en").map((m) => s.slice(m.start, m.end));
  assert.deepEqual(hits("Machine  learning rocks"), ["Machine  learning"]);
  assert.deepEqual(hits("machine learned"), []);        // boundary blocks partial
});

test("CJK entries use substring matching, no word boundaries", () => {
  const idx = vocab.buildVocabIndex([{ id: "e3", text: "机器学习", language: "zh" }]);
  const hits = (s) => vocab.findVocabMatches(s, idx, "zh").map((m) => s.slice(m.start, m.end));
  assert.deepEqual(hits("我们用机器学习做翻译"), ["机器学习"]);
  assert.deepEqual(vocab.findVocabMatches("机器学习", idx, "en"), []); // language separation
});

test("known entries are excluded unless highlightKnown", () => {
  const entries = [
    { id: "a", text: "alpha", language: "en", mastery: "known" },
    { id: "b", text: "beta", language: "en", mastery: "fuzzy" },
  ];
  const off = vocab.buildVocabIndex(entries);
  assert.deepEqual(vocab.findVocabMatches("alpha beta", off, "en").map((m) => m.entryId), ["b"]);
  const on = vocab.buildVocabIndex(entries, { highlightKnown: true });
  assert.equal(vocab.findVocabMatches("alpha", on, "en").length, 1);
  assert.equal(vocab.shouldHighlightEntry(entries[0], {}), false);
  assert.equal(vocab.shouldHighlightEntry(entries[0], { highlightKnown: true }), true);
});

test("overlapping matches prefer the longer phrase", () => {
  const entries = [
    { id: "w", text: "learning", language: "en" },
    { id: "p", text: "machine learning", language: "en" },
  ];
  const idx = vocab.buildVocabIndex(entries);
  const m = vocab.findVocabMatches("machine learning", idx, "en");
  assert.deepEqual(m.map((x) => x.entryId), ["p"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/vocab-index.test.js`
Expected: FAIL — `Cannot find module '../vocab.js'`

- [ ] **Step 3: Implement vocab.js (matching part)**

```js
/**
 * Shared vocabulary-notebook logic.
 *
 * Pure functions only — no DOM, no chrome.* — so the side panel (script
 * tag), the background service worker (importScripts), and node --test
 * (require) all share one implementation. Follows settings.js.
 */
var YTD_VOCAB = (() => {
  const MASTERY_LEVELS = Object.freeze(["new", "fuzzy", "known"]);
  const MASTERY_LABELS = Object.freeze({
    new: "未掌握",
    fuzzy: "模糊",
    known: "已掌握",
  });
  const ENTRY_CAP = 2000;
  const CLOZE_BLANK = "______";

  function normalizeWhitespace(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function hasCJK(text) {
    return /[\u3400-\u9FFF\uF900-\uFAFF]/.test(String(text || ""));
  }

  function isSingleWord(text) {
    const normalized = normalizeWhitespace(text);
    return normalized.length > 0 && !normalized.includes(" ");
  }

  function createEntryId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "vocab-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  }

  function normalizeVocabEntry(input) {
    input = input || {};
    return {
      id:
        typeof input.id === "string" && input.id
          ? input.id
          : createEntryId(),
      text: normalizeWhitespace(input.text),
      language: input.language === "zh" ? "zh" : "en",
      meaning: String(input.meaning || "").trim(),
      contextEn: String(input.contextEn || "").trim(),
      contextZh: String(input.contextZh || "").trim(),
      videoId: String(input.videoId || ""),
      videoTitle: String(input.videoTitle || ""),
      timestampSeconds: Number.isFinite(input.timestampSeconds)
        ? input.timestampSeconds
        : 0,
      mastery: MASTERY_LEVELS.includes(input.mastery)
        ? input.mastery
        : "new",
      createdAt: Number.isFinite(input.createdAt)
        ? input.createdAt
        : Date.now(),
    };
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildPhrasePattern(text) {
    const normalized = normalizeWhitespace(text).toLowerCase();
    if (hasCJK(normalized)) {
      return new RegExp(escapeRegExp(normalized), "gi");
    }
    const flexible = normalized
      .split(" ")
      .map(escapeRegExp)
      .join("\\s+");
    return new RegExp("\\b" + flexible + "\\b", "gi");
  }

  function shouldHighlightEntry(entry, opts) {
    if (!entry) return false;
    if (entry.mastery === "known") {
      return Boolean(opts && opts.highlightKnown);
    }
    return true;
  }

  function buildVocabIndex(entries, opts) {
    const highlightKnown = Boolean(opts && opts.highlightKnown);
    const words = { en: new Map(), zh: new Map() };
    const phrases = { en: [], zh: [] };
    (entries || []).forEach((entry) => {
      if (!entry || !entry.text) return;
      if (!shouldHighlightEntry(entry, { highlightKnown })) return;
      const language = entry.language === "zh" ? "zh" : "en";
      const key = entry.text.toLowerCase();
      if (isSingleWord(entry.text)) {
        if (!words[language].has(key)) words[language].set(key, entry.id);
      } else if (!phrases[language].some((p) => p.key === key)) {
        phrases[language].push({
          key: key,
          pattern: buildPhrasePattern(entry.text),
          entryId: entry.id,
        });
      }
    });
    return { words: words, phrases: phrases, highlightKnown: highlightKnown };
  }

  function findVocabMatches(text, index, language) {
    const value = String(text || "");
    if (!value || !index) return [];
    const lang = language === "zh" ? "zh" : "en";
    const results = [];

    const tokenRe = /[A-Za-z0-9\u00C0-\u024F\u3400-\u9FFF]+(?:['\u2019][A-Za-z]+)?/g;
    let match;
    while ((match = tokenRe.exec(value))) {
      const entryId = index.words[lang].get(match[0].toLowerCase());
      if (entryId) {
        results.push({
          start: match.index,
          end: match.index + match[0].length,
          entryId: entryId,
        });
      }
    }

    index.phrases[lang].forEach((phrase) => {
      phrase.pattern.lastIndex = 0;
      let hit;
      while ((hit = phrase.pattern.exec(value))) {
        results.push({
          start: hit.index,
          end: hit.index + hit[0].length,
          entryId: phrase.entryId,
        });
      }
    });

    results.sort(
      (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start),
    );
    const kept = [];
    let lastEnd = -1;
    results.forEach((r) => {
      if (r.start >= lastEnd) {
        kept.push(r);
        lastEnd = r.end;
      }
    });
    return kept;
  }

  // (storage / cloze / export functions are appended in Tasks 2-3)

  return {
    MASTERY_LEVELS,
    MASTERY_LABELS,
    ENTRY_CAP,
    CLOZE_BLANK,
    normalizeWhitespace,
    hasCJK,
    isSingleWord,
    normalizeVocabEntry,
    shouldHighlightEntry,
    buildVocabIndex,
    findVocabMatches,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_VOCAB;
}
```

Note: `timestampSeconds: "12.9"` — `Number.isFinite("12.9")` is `false` (string), so it clamps to 0 per the test. Good.

- [ ] **Step 4: Run tests**

Run: `node --test tests/vocab-index.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add vocab.js tests/vocab-index.test.js
git commit -m "feat(vocab): entry model and whole-word/phrase/CJK matching engine"
```

---

### Task 2: `vocab.js` — storage helpers + meaning source + cloze

**Files:**
- Modify: `vocab.js`
- Test: `tests/vocab-storage.test.js`, `tests/vocab-cloze.test.js`

**Interfaces:**
- Consumes: Task 1 internals.
- Produces: `dedupeExisting(entries,text,language)→id|null`, `applyVocabSave(entries,entry)→{entries,status,duplicateId?,entry?}`, `applyVocabUpdate(entries,id,patch)→{entries,updated}`, `applyVocabDelete(entries,id)→{entries,removed}`, `resolveMeaningSource(selectionText,rowEnText,rowZhText)→"cache"|"ai"`, `blankFirstOccurrence(sentence,term)→string|null`, `generateClozeQuestions(entries,count,seed)→[{entry,prompt,hint,hasContext}]`.

- [ ] **Step 1: Write failing tests — storage**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const vocab = require("../vocab.js");

test("applyVocabSave dedupes on text+language, case/space-insensitive", () => {
  const existing = [
    { id: "keep", text: "Machine Learning", language: "en" },
  ];
  const dup = vocab.applyVocabSave(existing, { text: "machine   learning", language: "en" });
  assert.equal(dup.status, "duplicate");
  assert.equal(dup.duplicateId, "keep");
  const zh = vocab.applyVocabSave(existing, { text: "machine learning", language: "zh" });
  assert.equal(zh.status, "saved");
});

test("applyVocabSave caps at ENTRY_CAP dropping oldest", () => {
  const entries = Array.from({ length: vocab.ENTRY_CAP }, (_, i) => ({
    id: "old" + i,
    text: "w" + i,
    language: "en",
    createdAt: i,
  }));
  const outcome = vocab.applyVocabSave(entries, { text: "newest", language: "en" });
  assert.equal(outcome.entries.length, vocab.ENTRY_CAP);
  assert.equal(outcome.entries[0].text, "newest");
  assert.equal(outcome.entries.some((e) => e.id === "old0"), false);
});

test("applyVocabUpdate only accepts valid mastery; applyVocabDelete removes", () => {
  const entries = [{ id: "a", text: "x", language: "en", mastery: "new" }];
  const bad = vocab.applyVocabUpdate(entries, "a", { mastery: "banana" });
  assert.equal(bad.entries[0].mastery, "new");
  const good = vocab.applyVocabUpdate(entries, "a", { mastery: "fuzzy", meaning: " 试 " });
  assert.equal(good.entries[0].mastery, "fuzzy");
  assert.equal(good.entries[0].meaning, "试");
  assert.equal(good.updated, true);
  const del = vocab.applyVocabDelete(entries, "a");
  assert.deepEqual(del.entries, []);
  assert.equal(del.removed, true);
});

test("resolveMeaningSource: full-sentence coverage with cached ZH is free", () => {
  assert.equal(
    vocab.resolveMeaningSource(
      "The quick brown fox.",
      "the quick   brown fox.",
      "那只敏捷的棕色狐狸。",
    ),
    "cache",
  );
  assert.equal(
    vocab.resolveMeaningSource("fox", "The quick brown fox.", "狐狸。"),
    "ai",
  );
  assert.equal(
    vocab.resolveMeaningSource("The quick brown fox.", "The quick brown fox.", ""),
    "ai",
  );
});
```

- [ ] **Step 2: Write failing tests — cloze**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const vocab = require("../vocab.js");

test("blankFirstOccurrence replaces first hit, case-insensitive", () => {
  assert.equal(
    vocab.blankFirstOccurrence("I like to RUN in the morning. Run!", "run"),
    "I like to ______ in the morning. Run!",
  );
  assert.equal(vocab.blankFirstOccurrence("no match here", "run"), null);
});

test("generateClozeQuestions prioritizes unmastered and is seed-deterministic", () => {
  const entries = [
    { id: "1", text: "alpha", language: "en", contextEn: "alpha is here", meaning: "甲", mastery: "new" },
    { id: "2", text: "beta", language: "en", contextEn: "beta is there", mastery: "known" },
    { id: "3", text: "gamma", language: "en", contextEn: "gamma is everywhere", contextZh: "丙", mastery: "fuzzy" },
  ];
  const q1 = vocab.generateClozeQuestions(entries, 10, 42);
  const q2 = vocab.generateClozeQuestions(entries, 10, 42);
  assert.deepEqual(q1.map((q) => q.entry.id), q2.map((q) => q.entry.id));
  // priority: new+fuzzy first, known only fills remaining slots
  const ids = q1.map((q) => q.entry.id).sort();
  assert.deepEqual(ids, ["1", "2", "3"]);
  assert.equal(q1.find((q) => q.entry.id === "1").prompt, "______ is here");
  assert.equal(q1.find((q) => q.entry.id === "1").hint, "甲");
  assert.equal(q1.find((q) => q.entry.id === "3").hint, "丙"); // meaning fallback
  const noCtx = vocab.generateClozeQuestions(
    [{ id: "9", text: "delta", language: "en", contextEn: "", mastery: "new" }],
    5,
    7,
  );
  assert.equal(noCtx[0].hasContext, false);
  assert.equal(noCtx[0].prompt, null);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/vocab-storage.test.js tests/vocab-cloze.test.js`
Expected: FAIL — `vocab.applyVocabSave is not a function`

- [ ] **Step 4: Implement (append before the `return {`, extend the return object)**

```js
  function dedupeExisting(entries, text, language) {
    const key = normalizeWhitespace(text).toLowerCase();
    const lang = language === "zh" ? "zh" : "en";
    const found = (entries || []).find(
      (e) =>
        e &&
        e.language === lang &&
        normalizeWhitespace(e.text).toLowerCase() === key,
    );
    return found ? found.id : null;
  }

  function applyVocabSave(entries, rawEntry) {
    const entry = normalizeVocabEntry(rawEntry);
    const duplicateId = dedupeExisting(entries, entry.text, entry.language);
    if (duplicateId) {
      return { entries: entries || [], status: "duplicate", duplicateId: duplicateId };
    }
    const next = [entry].concat(entries || []);
    if (next.length > ENTRY_CAP) next.length = ENTRY_CAP;
    return { entries: next, status: "saved", entry: entry };
  }

  function applyVocabUpdate(entries, id, patch) {
    let updated = false;
    const next = (entries || []).map((entry) => {
      if (!entry || entry.id !== id) return entry;
      updated = true;
      const merged = Object.assign({}, entry);
      if (patch && MASTERY_LEVELS.includes(patch.mastery)) {
        merged.mastery = patch.mastery;
      }
      if (patch && typeof patch.meaning === "string") {
        merged.meaning = patch.meaning.trim();
      }
      return merged;
    });
    return { entries: next, updated: updated };
  }

  function applyVocabDelete(entries, id) {
    const next = (entries || []).filter((e) => e && e.id !== id);
    return { entries: next, removed: next.length !== (entries || []).length };
  }

  function resolveMeaningSource(selectionText, rowEnText, rowZhText) {
    const selection = normalizeWhitespace(selectionText).toLowerCase();
    const rowEn = normalizeWhitespace(rowEnText).toLowerCase();
    const zh = String(rowZhText || "").trim();
    if (!selection || !rowEn || !zh) return "ai";
    if (!rowEn.includes(selection) && !selection.includes(rowEn)) return "ai";
    return selection.length >= Math.floor(rowEn.length * 0.9)
      ? "cache"
      : "ai";
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function blankFirstOccurrence(sentence, term) {
    const s = normalizeWhitespace(sentence);
    const t = normalizeWhitespace(term);
    if (!s || !t) return null;
    const idx = s.toLowerCase().indexOf(t.toLowerCase());
    if (idx === -1) return null;
    return s.slice(0, idx) + CLOZE_BLANK + s.slice(idx + t.length);
  }

  function generateClozeQuestions(entries, count, seed) {
    const limit = Math.max(0, Number.isFinite(count) ? count : 10);
    const pool = (entries || []).filter((e) => e && e.text);
    const priority = pool.filter((e) => e.mastery !== "known");
    const candidates =
      priority.length >= limit || priority.length === pool.length
        ? priority
        : priority.concat(pool.filter((e) => e.mastery === "known"));
    const rand = mulberry32(Number.isFinite(seed) ? seed : 1);
    const copy = candidates.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy.slice(0, limit).map((entry) => {
      const prompt = blankFirstOccurrence(entry.contextEn, entry.text);
      return {
        entry: entry,
        prompt: prompt,
        hint: entry.meaning || entry.contextZh || "",
        hasContext: prompt !== null,
      };
    });
  }
```

Extend the return object with: `dedupeExisting, applyVocabSave, applyVocabUpdate, applyVocabDelete, resolveMeaningSource, blankFirstOccurrence, generateClozeQuestions`.

- [ ] **Step 5: Run tests**

Run: `node --test tests/vocab-storage.test.js tests/vocab-cloze.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add vocab.js tests/vocab-storage.test.js tests/vocab-cloze.test.js
git commit -m "feat(vocab): storage save/update/delete, meaning source, cloze generation"
```

---

### Task 3: `vocab.js` — export serialization

**Files:**
- Modify: `vocab.js`
- Test: `tests/vocab-export.test.js`

**Interfaces:**
- Produces: `vocabVideoUrl(entry)→string`, `toCsv(entries)→string`, `toAnkiTsv(entries)→string`.

- [ ] **Step 1: Write failing tests**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const vocab = require("../vocab.js");

const entry = {
  id: "e1",
  text: 'run, "fast"',
  language: "en",
  meaning: "/rʌn/ v. 跑\n; 运转",
  contextEn: "He likes to run, fast",
  contextZh: "他喜欢快跑",
  videoId: "dQw4w9WgXcQ",
  videoTitle: "A, Title",
  timestampSeconds: 12.9,
  mastery: "new",
  createdAt: 1700000000000,
};

test("vocabVideoUrl floors the timestamp", () => {
  assert.equal(vocab.vocabVideoUrl(entry), "https://youtu.be/dQw4w9WgXcQ?t=12");
});

test("toCsv escapes commas, quotes and newlines", () => {
  const csv = vocab.toCsv([entry]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "term,language,meaning,contextEn,contextZh,videoTitle,videoUrl,timestampSeconds,mastery,createdAt");
  assert.equal(lines[1], '"run, ""fast""",en,"/rʌn/ v. 跑 ; 运转",He likes to run, fast,他喜欢快跑,"A, Title",https://youtu.be/dQw4w9WgXcQ?t=12,12.9,new,2023-11-14T22:13:20.000Z");
});

test("toAnkiTsv strips tabs/newlines and bolds the term", () => {
  const tsv = vocab.toAnkiTsv([entry]);
  const [front, back] = tsv.split("\t");
  assert.equal(front, 'run, "fast"<br>He likes to <b>run, fast</b>');
  assert.match(back, /^\/rʌn\/ v\. 跑 ; 运转<br>source: A, Title$/);
  assert.equal(tsv.includes("\n"), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/vocab-export.test.js`
Expected: FAIL — not a function

- [ ] **Step 3: Implement**

```js
  function vocabVideoUrl(entry) {
    const t = Math.max(0, Math.floor(Number(entry && entry.timestampSeconds) || 0));
    return "https://youtu.be/" + (entry && entry.videoId) + "?t=" + t;
  }

  function csvEscape(value) {
    const s = String(value === undefined || value === null ? "" : value);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(entries) {
    const header = "term,language,meaning,contextEn,contextZh,videoTitle,videoUrl,timestampSeconds,mastery,createdAt";
    const lines = [header];
    (entries || []).forEach((e) => {
      const fields = [
        e.text,
        e.language,
        e.meaning,
        e.contextEn,
        e.contextZh,
        e.videoTitle,
        vocabVideoUrl(e),
        String(e.timestampSeconds),
        e.mastery,
        new Date(e.createdAt).toISOString(),
      ];
      lines.push(fields.map(csvEscape).join(","));
    });
    return lines.join("\n");
  }

  function ankiField(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/[\t\n\r]/g, " ")
      .trim();
  }

  function toAnkiTsv(entries) {
    return (entries || [])
      .map((e) => {
        const sentence = ankiField(e.contextEn);
        const term = ankiField(e.text);
        let bolded = sentence;
        if (term && sentence) {
          const idx = sentence.toLowerCase().indexOf(term.toLowerCase());
          if (idx !== -1) {
            bolded =
              sentence.slice(0, idx) +
              "<b>" +
              sentence.slice(idx, idx + term.length) +
              "</b>" +
              sentence.slice(idx + term.length);
          }
        }
        const front = ankiField(e.text) + "<br>" + bolded;
        const back =
          ankiField(e.meaning || e.contextZh) +
          "<br>source: " +
          ankiField(e.videoTitle);
        return front + "\t" + back;
      })
      .join("\n");
  }
```

Extend the return object with `vocabVideoUrl, toCsv, toAnkiTsv`.

- [ ] **Step 4: Run tests** — Run: `node --test tests/vocab-export.test.js` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add vocab.js tests/vocab-export.test.js
git commit -m "feat(vocab): CSV and Anki TSV export serialization"
```

---

### Task 4: `background.js` — storage routes

**Files:**
- Modify: `background.js` (line 16 area + dispatcher after `deleteNote` route; handlers near `handleDeleteNote` ~L1417-1443)
- Test: `tests/vocab-wiring.test.js`

**Interfaces:**
- Consumes: `YTD_VOCAB.applyVocabSave/applyVocabUpdate/applyVocabDelete` from Tasks 1-2.
- Produces: message contract — `{action:"saveVocabEntry", entry}→{success,status,duplicateId,entry}`, `{action:"getVocabEntries", videoId?}→{success,entries}`, `{action:"updateVocabEntry", id, patch}→{success}`, `{action:"deleteVocabEntry", id}→{success}`.

- [ ] **Step 1: Write the failing wiring test**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const bg = fs.readFileSync(path.resolve(__dirname, "..", "background.js"), "utf8");

test("background loads the vocab module via importScripts", () => {
  assert.match(bg, /importScripts\("vocab\.js"\);/);
});

test("dispatcher routes all four vocab storage actions", () => {
  ["saveVocabEntry", "getVocabEntries", "updateVocabEntry", "deleteVocabEntry"].forEach(
    (action) => assert.match(bg, new RegExp('message\\.action === "' + action + '"')),
  );
});

test("storage handlers use ytd_vocab key and YTD_VOCAB helpers", () => {
  const handlers = bg.match(/async function handle(Save|Get|Update|Delete)Vocab\w*\(/g) || [];
  assert.equal(handlers.length >= 4, true);
  assert.match(bg, /YTD_VOCAB\.applyVocabSave/);
  assert.match(bg, /YTD_VOCAB\.applyVocabUpdate/);
  assert.match(bg, /YTD_VOCAB\.applyVocabDelete/);
  assert.match(bg, /chrome\.storage\.local\.set\(\{ ytd_vocab: /);
});
```

- [ ] **Step 2: Run to verify failure** — Run: `node --test tests/vocab-wiring.test.js` — Expected: FAIL

- [ ] **Step 3: Implement**

After `importScripts("settings.js");` add `importScripts("vocab.js");`.

In the `onMessage` dispatcher (mirror the `deleteNote` route style), add:

```js
  if (message.action === "saveVocabEntry") {
    handleSaveVocabEntry(message.entry)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === "getVocabEntries") {
    handleGetVocabEntries(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === "updateVocabEntry") {
    handleUpdateVocabEntry(message.id, message.patch)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === "deleteVocabEntry") {
    handleDeleteVocabEntry(message.id)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
```

Near `handleDeleteNote`, add handlers:

```js
/**
 * Vocabulary notebook — mirrors the notes storage pattern, delegating
 * pure save/update/delete semantics to YTD_VOCAB.
 */
async function handleSaveVocabEntry(entry) {
  const result = await chrome.storage.local.get("ytd_vocab");
  const outcome = YTD_VOCAB.applyVocabSave(result.ytd_vocab || [], entry);
  await chrome.storage.local.set({ ytd_vocab: outcome.entries });
  return {
    success: true,
    status: outcome.status,
    duplicateId: outcome.duplicateId || null,
    entry: outcome.entry || null,
  };
}

async function handleGetVocabEntries(videoId) {
  const result = await chrome.storage.local.get("ytd_vocab");
  let entries = result.ytd_vocab || [];
  if (videoId) entries = entries.filter((e) => e && e.videoId === videoId);
  return { success: true, entries };
}

async function handleUpdateVocabEntry(id, patch) {
  const result = await chrome.storage.local.get("ytd_vocab");
  const outcome = YTD_VOCAB.applyVocabUpdate(result.ytd_vocab || [], id, patch);
  await chrome.storage.local.set({ ytd_vocab: outcome.entries });
  return { success: outcome.updated };
}

async function handleDeleteVocabEntry(id) {
  const result = await chrome.storage.local.get("ytd_vocab");
  const outcome = YTD_VOCAB.applyVocabDelete(result.ytd_vocab || [], id);
  await chrome.storage.local.set({ ytd_vocab: outcome.entries });
  return { success: outcome.removed };
}
```

- [ ] **Step 4: Run tests** — Run: `node --test tests/vocab-wiring.test.js` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add background.js tests/vocab-wiring.test.js
git commit -m "feat(vocab): background storage handlers and message routes"
```

---

### Task 5: dictionary lookup — prompt file + AI handler

**Files:**
- Create: `prompts/vocab-lookup.md`
- Modify: `background.js`
- Test: `tests/vocab-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `getSettings`, `loadPromptSection`, `requestAiCompletion` (existing).
- Produces: `{action:"lookupVocabMeaning", text, contextEn, videoTitle}→{success,meaning}` or `{success:false,error}`.

- [ ] **Step 1: Extend wiring test**

```js
test("lookupVocabMeaning route exists with JSON-mode AI call", () => {
  assert.match(bg, /message\.action === "lookupVocabMeaning"/);
  assert.match(bg, /async function handleLookupVocabMeaning\(/);
  assert.match(bg, /loadPromptSection\(\s*"vocab-lookup\.md"/);
});

test("vocab-lookup prompt file follows the prompt conventions", () => {
  const prompt = fs.readFileSync(
    path.resolve(__dirname, "..", "prompts", "vocab-lookup.md"),
    "utf8",
  );
  assert.match(prompt, /## System prompt/);
  assert.match(prompt, /## User prompt/);
  assert.match(prompt, /\{selectedText\}/);
  assert.match(prompt, /\{transcriptContext\}/);
  assert.match(prompt, /\{videoTitle\}/);
});
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Create `prompts/vocab-lookup.md`**

```markdown
# Vocab Lookup Prompt

Used in `background.js` when the user selects text in the transcript and the
selection card needs a dictionary-style meaning before saving to the vocab
notebook.

## System prompt

```
You are a concise bilingual dictionary for an English learner whose
interface language is Simplified Chinese.
Reply with ONLY one JSON object: {"meaning": "..."} — no markdown fences,
no commentary.

Rules:
- Single English word: phonetic (if common) + part(s) of speech + up to 3
  glosses, e.g. "/rʌn/ v. 跑；运转；经营".
- Multi-word phrase: one short natural Chinese paraphrase.
- Full sentence: a complete Simplified Chinese translation.
- Chinese input: give the matching English gloss.
- Keep words/phrases under ~60 characters. No examples, no usage notes.
```

## User prompt

```
VIDEO: {videoTitle}

SELECTED: "{selectedText}"

CONTEXT: {transcriptContext}

Return the JSON meaning now.
```

## Variables

- `{videoTitle}` — video title.
- `{selectedText}` — the text the user selected.
- `{transcriptContext}` — the transcript sentence containing the selection,
  or `None`.
```

- [ ] **Step 4: Add route + handler in `background.js`**

Dispatcher:

```js
  if (message.action === "lookupVocabMeaning") {
    handleLookupVocabMeaning(message.text, message.contextEn, message.videoTitle)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
```

Handler (mirror `handleExplainSelection` structure):

```js
/**
 * Dictionary-style meaning for a selection. One bounded, non-thinking
 * JSON call — the cheapest AI touchpoint in the extension.
 */
async function handleLookupVocabMeaning(text, contextEn, videoTitle) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "DeepSeek API key not configured.",
      };
    }
    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText: String(text || "").trim(),
      transcriptContext: contextEn || "None",
    };
    const systemPrompt = await loadPromptSection(
      "vocab-lookup.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "vocab-lookup.md",
      "User prompt",
      variables,
    );
    debugLog("[YouTube Digest] Requesting vocab lookup");
    const { text: raw } = await requestAiCompletion({
      maxTokens: 300,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    const parsed = JSON.parse(raw);
    const meaning =
      parsed && typeof parsed.meaning === "string"
        ? parsed.meaning.trim()
        : "";
    if (!meaning) return { success: false, error: "EMPTY_MEANING" };
    return { success: true, meaning: meaning };
  } catch (error) {
    console.error("Vocab lookup error:", error);
    return { success: false, error: error.message };
  }
}
```

Note: verify `loadPromptSection` and `requestAiCompletion` signatures against the file at execution; adapt argument names if they differ, keeping JSON mode and non-thinking defaults.

- [ ] **Step 5: Run tests** — Run: `node --test tests/vocab-wiring.test.js` — Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add prompts/vocab-lookup.md background.js tests/vocab-wiring.test.js
git commit -m "feat(vocab): AI dictionary lookup prompt and handler"
```

---

### Task 6: selection card — lookup, save, speak, cross-highlight

**Files:**
- Modify: `sidepanel.js` (`setupExplainFeature` ~L1710-1840, `dismissSelectionActions` ~L1700), `sidepanel.html` (script tag)
- Test: `tests/vocab-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `YTD_VOCAB.resolveMeaningSource`, message routes from Tasks 4-5, `transcriptParagraphCache`, `currentVideoId/currentVideoTitle`, `transcriptTranslationCacheKey`.
- Produces (used by Tasks 7-9): `vocabSpeak(text, language)`, `loadVocabEntries()` (defined in Task 7 — this task calls it defensively via `typeof`), `refreshVocabHighlights()` (Task 8; same defensive call), `applyCrossHighlight(range)` / `clearCrossHighlight()`.

- [ ] **Step 1: Extend wiring test**

```js
const panel = fs.readFileSync(path.resolve(__dirname, "..", "sidepanel.js"), "utf8");

test("sidepanel loads vocab.js and keeps the selection card contract", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "..", "sidepanel.html"), "utf8");
  assert.match(html, /<script src="vocab\.js"><\/script>/);
  assert.match(panel, /id="explainTooltip"/);
  assert.match(panel, /class="explain-btn"/);
  assert.match(panel, /class="selection-note-btn"/);
});

test("selection card performs cached-or-AI meaning lookup with a generation guard", () => {
  assert.match(panel, /YTD_VOCAB\.resolveMeaningSource\(/);
  assert.match(panel, /action: "lookupVocabMeaning"/);
  assert.match(panel, /vocabLookupGeneration/);
  assert.match(panel, /transcriptParagraphCache\.get\(/); // ZH from cache, never the placeholder
});

test("selection card saves entries and clears cross-highlight on dismiss", () => {
  assert.match(panel, /action: "saveVocabEntry"/);
  assert.match(panel, /cross-highlight-target/);
  assert.match(panel, /function dismissSelectionActions\([\s\S]*?clearCrossHighlight\(\)/);
});
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Implement in `sidepanel.html`**

Before `<script src="settings.js"></script>` add:

```html
    <script src="vocab.js"></script>
```

- [ ] **Step 4: Implement in `sidepanel.js`**

Add near the top-level state declarations (near `selectionActionsController` ~L108):

```js
// ——— Vocab notebook state ———
let vocabLookupGeneration = 0;
let currentSelectionMeaning = "";
```

Add utilities (above `setupExplainFeature`):

```js
function vocabSpeak(text, language) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const value = String(text || "").trim();
  if (!value) return;
  const utterance = new SpeechSynthesisUtterance(value);
  utterance.lang = language === "zh" ? "zh-CN" : "en-US";
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function clearCrossHighlight() {
  document
    .querySelectorAll(".cross-highlight-target")
    .forEach((el) => el.classList.remove("cross-highlight-target"));
}

/**
 * Highlights the counterpart-language span(s) of every row the selection
 * touches. Bilingual mode only; single-language selections only.
 */
function applyCrossHighlight(range) {
  clearCrossHighlight();
  if (currentTranscriptMode !== "bilingual" || !range) return;
  const anchorEl =
    range.startContainer.nodeType === 1
      ? range.startContainer
      : range.startContainer.parentElement;
  const focusEl =
    range.endContainer.nodeType === 1
      ? range.endContainer
      : range.endContainer.parentElement;
  if (!anchorEl || !focusEl) return;
  const anchorSpan = anchorEl.closest(
    ".transcript-original, .transcript-translation",
  );
  const focusSpan = focusEl.closest(
    ".transcript-original, .transcript-translation",
  );
  if (!anchorSpan || !focusSpan) return;
  if (!anchorSpan.classList.contains("transcript-original") ||
      !focusSpan.classList.contains("transcript-original")) {
    if (!anchorSpan.classList.contains("transcript-translation") ||
        !focusSpan.classList.contains("transcript-translation")) {
      return; // selection mixes languages — skip
    }
  }
  const sourceIsOriginal =
    anchorSpan.classList.contains("transcript-original");
  const counterpart = sourceIsOriginal
    ? ".transcript-translation"
    : ".transcript-original";
  document.querySelectorAll("#transcriptList .transcript-entry").forEach((row) => {
    try {
      if (range.intersectsNode(row)) {
        row.querySelector(counterpart)?.classList.add("cross-highlight-target");
      }
    } catch {
      /* range no longer valid */
    }
  });
}
```

Rework `setupExplainFeature`'s tooltip innerHTML (keep id/classes) to:

```js
  tooltip.innerHTML = `
    <div class="selection-term-row">
      <span class="selection-term"></span>
      <button class="selection-speak-btn" type="button" title="朗读" aria-label="Read selection aloud">🔊</button>
    </div>
    <div class="selection-meaning"></div>
    <div class="selection-actions">
      <button class="selection-save-btn" type="button">收藏到单词本</button>
      <button class="explain-btn" type="button">Explain</button>
      <button class="selection-note-btn" type="button">Note</button>
    </div>
  `;
```

Track `selectedLanguage`, `selectedRowEn`, `selectedRowZh`, `selectedRowSeconds` in the mouseup handler; after positioning the tooltip call:

```js
function resolveSelectionContext(range, transcriptList) {
  const startElement =
    range.startContainer.nodeType === 1
      ? range.startContainer
      : range.startContainer.parentElement;
  const row = startElement?.closest(".transcript-entry");
  const anchorSpan = startElement?.closest(
    ".transcript-original, .transcript-translation",
  );
  const language = anchorSpan?.classList.contains("transcript-translation")
    ? "zh"
    : "en";
  const rowEn = row?.querySelector(".transcript-original")?.textContent?.trim() || "";
  const segmentId = row?.dataset.segmentId || "";
  const cachedZh = segmentId
    ? transcriptParagraphCache.get(
        `${currentVideoId}:zh:semantic:${segmentId}`,
      ) || ""
    : "";
  const rowZh =
    cachedZh ||
    (row?.classList.contains("translated")
      ? row?.querySelector(".transcript-translation")?.textContent?.trim() || ""
      : "");
  const seconds = Number(row?.dataset.seconds);
  return {
    language,
    contextEn: rowEn,
    contextZh: rowZh,
    timestampSeconds: Number.isFinite(seconds) ? seconds : 0,
  };
}
```

In the mouseup branch (after `selectedText = text`):

```js
        const context = resolveSelectionContext(range, transcriptList);
        selectedLanguage = context.language;
        selectedRowEn = context.contextEn;
        selectedRowZh = context.contextZh;
        applyCrossHighlight(range);

        const termEl = tooltip.querySelector(".selection-term");
        const meaningEl = tooltip.querySelector(".selection-meaning");
        const shownTerm =
          text.length > 60 ? text.slice(0, 60) + "…" : text;
        termEl.textContent = shownTerm;
        currentSelectionMeaning = "";

        if (
          YTD_VOCAB.resolveMeaningSource(text, selectedRowEn, selectedRowZh) ===
          "cache"
        ) {
          currentSelectionMeaning = selectedRowZh;
          meaningEl.textContent = currentSelectionMeaning;
          meaningEl.classList.remove("pending", "error");
        } else if (text.length <= 200) {
          meaningEl.textContent = "翻译中…";
          meaningEl.classList.add("pending");
          meaningEl.classList.remove("error");
          vocabLookupGeneration += 1;
          const generation = vocabLookupGeneration;
          chrome.runtime.sendMessage(
            {
              action: "lookupVocabMeaning",
              text: text,
              contextEn: selectedRowEn,
              videoTitle: currentVideoTitle,
            },
            (result) => {
              if (generation !== vocabLookupGeneration) return;
              if (result && result.success) {
                currentSelectionMeaning = result.meaning;
                meaningEl.textContent = result.meaning;
                meaningEl.classList.remove("pending", "error");
              } else {
                meaningEl.textContent = "释义获取失败，点击重试";
                meaningEl.classList.remove("pending");
                meaningEl.classList.add("error");
              }
            },
          );
        } else {
          meaningEl.textContent = "";
          meaningEl.classList.remove("pending", "error");
        }
```

Meaning retry: click on `.selection-meaning.error` re-triggers by dispatching a synthetic mouseup? Simpler — keep a module-level `rerunLastLookup` closure set inside setup; on click call it. Implement as: store `lastLookup = () => {...}` and `meaningEl.addEventListener("click", () => { if (meaningEl.classList.contains("error") && lastLookup) lastLookup(); });`

Speak + save handlers (inside setupExplainFeature):

```js
  tooltip
    .querySelector(".selection-speak-btn")
    .addEventListener("click", (event) => {
      event.stopPropagation();
      vocabSpeak(selectedText, selectedLanguage);
    });

  tooltip
    .querySelector(".selection-save-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText || !currentVideoId) return;
      const button = event.currentTarget;
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "保存中…";
      try {
        const result = await chrome.runtime.sendMessage({
          action: "saveVocabEntry",
          entry: {
            text: selectedText,
            language: selectedLanguage,
            meaning: currentSelectionMeaning,
            contextEn: selectedRowEn,
            contextZh: selectedRowZh,
            videoId: currentVideoId,
            videoTitle: currentVideoTitle,
            timestampSeconds: selectedTimestamp,
          },
        });
        if (result?.success && result.status === "duplicate") {
          button.textContent = "Already saved ✓";
        } else {
          button.textContent = "Saved ✓";
          vocabSpeak(selectedText, selectedLanguage);
          if (typeof loadVocabEntries === "function") await loadVocabEntries();
          if (typeof refreshVocabHighlights === "function") refreshVocabHighlights();
        }
      } catch (error) {
        button.textContent = "保存失败";
      } finally {
        setTimeout(() => {
          button.textContent = originalText;
          button.disabled = false;
        }, 1500);
      }
    });
```

Extend `dismissSelectionActions`:

```js
function dismissSelectionActions(clearSelection = false) {
  const tooltip = document.getElementById("explainTooltip");
  if (tooltip) tooltip.style.display = "none";
  vocabLookupGeneration += 1; // invalidate any in-flight lookup
  clearCrossHighlight();
  if (clearSelection) window.getSelection()?.removeAllRanges();
}
```

Declare `let selectedLanguage = "en"; let selectedRowEn = ""; let selectedRowZh = "";` at setup scope alongside `selectedText`/`selectedTimestamp`.

- [ ] **Step 5: Run all tests** — Run: `npm test` — Expected: PASS (existing + new)

- [ ] **Step 6: Commit**

```bash
git add sidepanel.js sidepanel.html tests/vocab-wiring.test.js
git commit -m "feat(vocab): selection card with meaning lookup, save, speak, cross-highlight"
```

---

### Task 7: vocab tab — markup, list, mastery, listen-back, filters

**Files:**
- Modify: `sidepanel.html` (tab + panel), `sidepanel.js` (state + rendering + switchTab)
- Test: `tests/vocab-wiring.test.js` (extend)

**Interfaces:**
- Consumes: message routes (Task 4), `YTD_VOCAB.MASTERY_LABELS`, `seekTo`, `switchTab`, `vocabSpeak`, `renderSubtitleInlineMarkup`-style escaping via `escapeHtml`.
- Produces: `currentVocabEntries` (array), `loadVocabEntries()`, `renderVocabList()`, `filteredVocabEntries()`, `currentVocabMasteryFilter`, `currentVocabScope`.

- [ ] **Step 1: Extend wiring test**

```js
test("vocab tab markup and tab button exist", () => {
  assert.match(html, /data-tab="vocab"/);
  assert.match(html, /data-panel="vocab"/);
  assert.match(html, /id="vocabList"/);
  assert.match(html, /id="vocabQuiz"/);
});

test("vocab list renders mastery cycle, listen-back, delete", () => {
  assert.match(panel, /async function loadVocabEntries\(/);
  assert.match(panel, /function renderVocabList\(/);
  assert.match(panel, /action: "updateVocabEntry"/);
  assert.match(panel, /action: "deleteVocabEntry"/);
  assert.match(panel, /function playVocabEntry\(/);
  assert.match(panel, /switchTab\("transcript"\)/);
});
```

(Add `let html = fs.readFileSync(...)` reuse from Task 6 test if not already shared — the file already reads `sidepanel.html` as `html` in Task 6's first test; hoist that read to the top of the file so all tests share `panel` and `html`.)

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Implement markup in `sidepanel.html`**

Tab button after the Notes tab:

```html
        <button class="tab" data-tab="vocab">单词本</button>
```

Panel after the notes panel:

```html
        <!-- TAB: 单词本 (vocab notebook) -->
        <div class="tab-panel" data-panel="vocab">
          <div class="section">
            <div class="section-header vocab-section-header">
              <div class="section-title">
                单词本 <span class="vocab-count" id="vocabCount"></span>
              </div>
              <div class="vocab-tools">
                <button class="enhance-btn" id="vocabQuizBtn" type="button">
                  自测
                </button>
                <button class="enhance-btn" id="vocabExportCsvBtn" type="button">
                  CSV
                </button>
                <button class="enhance-btn" id="vocabExportAnkiBtn" type="button">
                  Anki
                </button>
              </div>
            </div>
            <div class="vocab-filters" role="group" aria-label="单词本筛选">
              <button class="enhance-btn active" data-vocab-mastery="all" type="button">全部</button>
              <button class="enhance-btn" data-vocab-mastery="new" type="button">未掌握</button>
              <button class="enhance-btn" data-vocab-mastery="fuzzy" type="button">模糊</button>
              <button class="enhance-btn" data-vocab-mastery="known" type="button">已掌握</button>
              <span class="vocab-filter-sep" aria-hidden="true"></span>
              <button class="enhance-btn active" id="vocabFilterThis" type="button">本视频</button>
              <button class="enhance-btn" id="vocabFilterAll" type="button">全部</button>
            </div>
            <p class="notes-intro" id="vocabIntro">
              在字幕中选中单词、短语或句子，点"收藏到单词本"即可保存。
            </p>
            <div id="vocabQuiz" class="vocab-quiz" hidden></div>
            <div id="vocabList"></div>
          </div>
        </div>
```

- [ ] **Step 4: Implement state + logic in `sidepanel.js`**

State (near other `let currentNotes...` declarations):

```js
let currentVocabEntries = [];
let currentVocabMasteryFilter = "all";
let currentVocabScope = "all";
```

Core functions (near the notes functions):

```js
async function loadVocabEntries() {
  try {
    const videoId = currentVocabScope === "this" ? currentVideoId : undefined;
    const result = await chrome.runtime.sendMessage({
      action: "getVocabEntries",
      videoId,
    });
    currentVocabEntries = result?.success ? result.entries : [];
    renderVocabList();
    if (typeof refreshVocabHighlightIndex === "function") {
      refreshVocabHighlightIndex();
      refreshVocabHighlights();
    }
  } catch (error) {
    debugLog("[YouTube Digest] loadVocabEntries failed:", error);
  }
}

function filteredVocabEntries() {
  return currentVocabEntries.filter(
    (e) =>
      currentVocabMasteryFilter === "all" ||
      e.mastery === currentVocabMasteryFilter,
  );
}

function playVocabEntry(entry) {
  switchTab("transcript");
  seekTo(entry.timestampSeconds);
}

function vocabTimestampLabel(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderVocabList() {
  const listEl = document.getElementById("vocabList");
  const introEl = document.getElementById("vocabIntro");
  const countEl = document.getElementById("vocabCount");
  if (!listEl) return;

  const entries = filteredVocabEntries();
  if (countEl) {
    countEl.textContent = currentVocabEntries.length
      ? `· ${currentVocabEntries.length}`
      : "";
  }

  if (!entries.length) {
    listEl.innerHTML = "";
    if (introEl) introEl.style.display = "block";
    return;
  }
  if (introEl) introEl.style.display = "none";

  listEl.innerHTML = "";
  entries.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "vocab-item";
    item.dataset.vocabId = entry.id;

    const contextEnHtml = (() => {
      const sentence = escapeHtml(entry.contextEn || "");
      if (!sentence || !entry.text) return sentence || "—";
      const idx = entry.contextEn.toLowerCase().indexOf(
        YTD_VOCAB.normalizeWhitespace(entry.text).toLowerCase(),
      );
      if (idx === -1) return sentence;
      return (
        escapeHtml(entry.contextEn.slice(0, idx)) +
        `<mark class="vocab-highlight">${escapeHtml(entry.contextEn.slice(idx, idx + entry.text.length))}</mark>` +
        escapeHtml(entry.contextEn.slice(idx + entry.text.length))
      );
    })();

    item.innerHTML = `
      <div class="vocab-term-row">
        <span class="vocab-term">${escapeHtml(entry.text)}</span>
        <span class="vocab-lang-badge">${entry.language === "zh" ? "ZH" : "EN"}</span>
        <button class="vocab-speak-btn" type="button" title="朗读" aria-label="朗读">🔊</button>
      </div>
      <div class="vocab-meaning">${escapeHtml(entry.meaning || "") || '<span class="muted">（无释义）</span>'}</div>
      <div class="vocab-context">
        <div class="vocab-context-en">${contextEnHtml}</div>
        ${entry.contextZh ? `<div class="vocab-context-zh">${escapeHtml(entry.contextZh)}</div>` : '<div class="vocab-context-zh muted">（翻译未就绪）</div>'}
      </div>
      <div class="vocab-meta">
        <button class="vocab-timestamp" type="button" title="${escapeHtml(entry.videoTitle)}">▶ ${vocabTimestampLabel(entry.timestampSeconds)}</button>
        <span class="vocab-date">${new Date(entry.createdAt).toLocaleDateString()}</span>
        <span class="vocab-actions">
          <button class="vocab-mastery mastery-${entry.mastery}" type="button">${YTD_VOCAB.MASTERY_LABELS[entry.mastery]}</button>
          <button class="vocab-delete" type="button" aria-label="删除" title="删除">✕</button>
        </span>
      </div>
    `;

    item.querySelector(".vocab-speak-btn").addEventListener("click", () => {
      vocabSpeak(entry.text, entry.language);
    });
    item.querySelector(".vocab-timestamp").addEventListener("click", () => {
      if (entry.videoId === currentVideoId) {
        playVocabEntry(entry);
      } else {
        window.open(YTD_VOCAB.vocabVideoUrl(entry), "_blank");
      }
    });
    item.querySelector(".vocab-mastery").addEventListener("click", async () => {
      const order = YTD_VOCAB.MASTERY_LEVELS;
      const next = order[(order.indexOf(entry.mastery) + 1) % order.length];
      entry.mastery = next; // optimistic
      await chrome.runtime.sendMessage({
        action: "updateVocabEntry",
        id: entry.id,
        patch: { mastery: next },
      });
      renderVocabList();
      if (typeof refreshVocabHighlightIndex === "function") {
        refreshVocabHighlightIndex();
        refreshVocabHighlights();
      }
    });
    item.querySelector(".vocab-delete").addEventListener("click", async () => {
      await chrome.runtime.sendMessage({
        action: "deleteVocabEntry",
        id: entry.id,
      });
      currentVocabEntries = currentVocabEntries.filter(
        (e) => e.id !== entry.id,
      );
      renderVocabList();
      if (typeof refreshVocabHighlightIndex === "function") {
        refreshVocabHighlightIndex();
        refreshVocabHighlights();
      }
    });

    listEl.appendChild(item);
  });
}
```

Filter wiring + tab switch (inside the init section where tabs are bound ~L399 and `switchTab`):

```js
function setupVocabTabControls() {
  document.querySelectorAll("[data-vocab-mastery]").forEach((button) => {
    button.addEventListener("click", () => {
      currentVocabMasteryFilter = button.dataset.vocabMastery;
      document
        .querySelectorAll("[data-vocab-mastery]")
        .forEach((b) => b.classList.toggle("active", b === button));
      renderVocabList();
    });
  });
  const thisBtn = document.getElementById("vocabFilterThis");
  const allBtn = document.getElementById("vocabFilterAll");
  thisBtn?.addEventListener("click", () => {
    currentVocabScope = "this";
    thisBtn.classList.add("active");
    allBtn?.classList.remove("active");
    void loadVocabEntries();
  });
  allBtn?.addEventListener("click", () => {
    currentVocabScope = "all";
    allBtn.classList.add("active");
    thisBtn?.classList.remove("active");
    void loadVocabEntries();
  });
  // default scope: all
  allBtn?.classList.add("active");
  thisBtn?.classList.remove("active");
}
```

Call `setupVocabTabControls(); loadVocabEntries();` during panel init. In `switchTab`, extend the notes-like block:

```js
  if (tabName === "vocab") {
    requestAnimationFrame(() => {
      const contentArea = document.getElementById("contentArea");
      if (contentArea) contentArea.scrollTop = 0;
    });
    void loadVocabEntries();
  }
```

- [ ] **Step 5: Run all tests** — Run: `npm test` — Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add sidepanel.js sidepanel.html tests/vocab-wiring.test.js
git commit -m "feat(vocab): vocab tab with filters, mastery cycling, listen-back"
```

---

### Task 8: re-appearance highlight engine + render hooks

**Files:**
- Modify: `sidepanel.js` (`renderTranscriptModeRows` end ~L2662, `updateTranslatedRow` ~L2681, vocab functions)
- Test: `tests/vocab-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `YTD_VOCAB.buildVocabIndex/findVocabMatches`, `currentVocabEntries`.
- Produces: `vocabHighlightIndex`, `refreshVocabHighlightIndex()`, `refreshVocabHighlights()`, `applyVocabHighlights(rootEl)`, `clearVocabHighlights(root)`.

- [ ] **Step 1: Extend wiring test**

```js
test("highlight engine walks text nodes but skips any mark, and never unwraps search marks", () => {
  assert.match(panel, /function applyVocabHighlights\(/);
  assert.match(panel, /closest\("mark"\)/);
  assert.match(panel, /mark\.vocab-highlight/);
  const clearFn = panel.match(/function clearVocabHighlights\([\s\S]*?\n\}/)?.[0] || "";
  assert.equal(clearFn.includes("transcript-search-highlight"), false);
});

test("render pipeline re-applies vocab highlights", () => {
  assert.match(panel, /refreshTranscriptSearch\(\{ preserveIndex: false, scroll: false \}\);\s*\n\s*refreshVocabHighlights\(\);/);
  assert.match(panel, /function updateTranslatedRow[\s\S]*?applyVocabHighlights\(row\);/);
});
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Implement**

```js
let vocabHighlightIndex = null;
let vocabHighlightKnown = false; // future setting hook; default off

function refreshVocabHighlightIndex() {
  vocabHighlightIndex = YTD_VOCAB.buildVocabIndex(currentVocabEntries, {
    highlightKnown: vocabHighlightKnown,
  });
}

function clearVocabHighlights(root) {
  (root || document)
    .querySelectorAll("mark.vocab-highlight")
    .forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(
        document.createTextNode(mark.textContent || ""),
        mark,
      );
      parent.normalize();
    });
}

function applyVocabHighlights(rootEl) {
  const root = rootEl || document.getElementById("transcriptList");
  if (!root || !vocabHighlightIndex) return;
  const wordsEmpty =
    !vocabHighlightIndex.words.en.size &&
    !vocabHighlightIndex.words.zh.size;
  const phrasesEmpty =
    !vocabHighlightIndex.phrases.en.length &&
    !vocabHighlightIndex.phrases.zh.length;
  if (wordsEmpty && phrasesEmpty) return;

  root
    .querySelectorAll(".transcript-original, .transcript-translation")
    .forEach((span) => {
      const language = span.classList.contains("transcript-original")
        ? "en"
        : "zh";
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.parentNode && node.parentNode.closest("mark")
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      });
      const textNodes = [];
      let node;
      while ((node = walker.nextNode())) textNodes.push(node);

      textNodes.forEach((textNode) => {
        const matches = YTD_VOCAB.findVocabMatches(
          textNode.nodeValue,
          vocabHighlightIndex,
          language,
        );
        if (!matches.length) return;
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        matches.forEach(({ start, end, entryId }) => {
          if (start > cursor) {
            fragment.appendChild(
              document.createTextNode(textNode.nodeValue.slice(cursor, start)),
            );
          }
          const mark = document.createElement("mark");
          mark.className = "vocab-highlight";
          mark.dataset.vocabId = entryId;
          mark.title = "已收藏";
          mark.textContent = textNode.nodeValue.slice(start, end);
          fragment.appendChild(mark);
          cursor = end;
        });
        if (cursor < textNode.nodeValue.length) {
          fragment.appendChild(
            document.createTextNode(textNode.nodeValue.slice(cursor)),
          );
        }
        textNode.parentNode.replaceChild(fragment, textNode);
      });
    });
}

function refreshVocabHighlights() {
  const list = document.getElementById("transcriptList");
  if (!list) return;
  clearVocabHighlights(list);
  applyVocabHighlights(list);
}
```

Hooks: in `renderTranscriptModeRows`, directly after `refreshTranscriptSearch({ preserveIndex: false, scroll: false });` add `refreshVocabHighlights();`. In `updateTranslatedRow`, after `copy.outerHTML = ...` (and before or after the retry-button wiring — after), add `applyVocabHighlights(row);`.

Note the ordering subtlety: `loadVocabEntries()` must have run once before the first render for highlights to appear on video load. Wire `loadVocabEntries()` into panel init (Task 7) and into the transcript-loaded path (`startDigest` success / cached render) — add `void loadVocabEntries();` wherever `renderTranscript()` is invoked after data load; simplest: at the end of `renderTranscriptModeRows` also do `if (!vocabHighlightIndex) refreshVocabHighlightIndex();` as a defensive default.

- [ ] **Step 4: Run all tests** — Run: `npm test` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add sidepanel.js tests/vocab-wiring.test.js
git commit -m "feat(vocab): re-appearance highlight engine wired into render pipeline"
```

---

### Task 9: export + speak wiring + quiz mode

**Files:**
- Modify: `sidepanel.js`
- Test: `tests/vocab-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `YTD_VOCAB.toCsv/toAnkiTsv/generateClozeQuestions/MASTERY_LABELS`, `filteredVocabEntries`.
- Produces: `exportVocabCsv()`, `exportVocabAnki()`, `startVocabQuiz()`, `renderVocabQuiz()`, `exitVocabQuiz()`.

- [ ] **Step 1: Extend wiring test**

```js
test("export uses YTD_VOCAB serializers with blob download", () => {
  assert.match(panel, /YTD_VOCAB\.toCsv\(/);
  assert.match(panel, /YTD_VOCAB\.toAnkiTsv\(/);
  assert.match(panel, /URL\.createObjectURL\(/);
});

test("quiz mode grades into mastery updates", () => {
  assert.match(panel, /YTD_VOCAB\.generateClozeQuestions\(/);
  assert.match(panel, /function startVocabQuiz\(/);
  assert.match(panel, /显示答案/);
  assert.match(panel, /认识/);
});
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL

- [ ] **Step 3: Implement**

Export:

```js
function downloadTextFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function vocabExportDate() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function exportVocabCsv() {
  if (!currentVocabEntries.length) return;
  downloadTextFile(
    `youtube-digest-vocab-${vocabExportDate()}.csv`,
    YTD_VOCAB.toCsv(currentVocabEntries),
    "text/csv;charset=utf-8",
  );
}

function exportVocabAnki() {
  if (!currentVocabEntries.length) return;
  downloadTextFile(
    `youtube-digest-vocab-anki-${vocabExportDate()}.txt`,
    YTD_VOCAB.toAnkiTsv(currentVocabEntries),
    "text/plain;charset=utf-8",
  );
}
```

Quiz:

```js
let vocabQuizState = null;

function startVocabQuiz() {
  const pool = filteredVocabEntries();
  if (!pool.length) return;
  vocabQuizState = {
    questions: YTD_VOCAB.generateClozeQuestions(
      pool,
      10,
      Date.now() % 2147483647,
    ),
    index: 0,
    results: { known: 0, fuzzy: 0, new: 0 },
  };
  renderVocabQuiz();
}

function exitVocabQuiz() {
  vocabQuizState = null;
  const quizEl = document.getElementById("vocabQuiz");
  const listEl = document.getElementById("vocabList");
  if (quizEl) {
    quizEl.hidden = true;
    quizEl.innerHTML = "";
  }
  if (listEl) listEl.style.display = "";
  renderVocabList();
}

async function gradeVocabQuizQuestion(mastery) {
  if (!vocabQuizState) return;
  const question = vocabQuizState.questions[vocabQuizState.index];
  vocabQuizState.results[mastery] = (vocabQuizState.results[mastery] || 0) + 1;
  question.entry.mastery = mastery; // optimistic local
  await chrome.runtime.sendMessage({
    action: "updateVocabEntry",
    id: question.entry.id,
    patch: { mastery },
  });
  vocabQuizState.index += 1;
  renderVocabQuiz();
}

function renderVocabQuiz() {
  const quizEl = document.getElementById("vocabQuiz");
  const listEl = document.getElementById("vocabList");
  if (!quizEl) return;
  if (!vocabQuizState) return;
  quizEl.hidden = false;
  if (listEl) listEl.style.display = "none";
  quizEl.innerHTML = "";

  const done = vocabQuizState.index >= vocabQuizState.questions.length;
  const frame = document.createElement("div");
  frame.className = "vocab-quiz-frame";

  if (done) {
    const { known, fuzzy, new: newCount } = vocabQuizState.results;
    frame.innerHTML = `
      <div class="vocab-quiz-title">自测完成</div>
      <div class="vocab-quiz-score">认识 ${known} · 模糊 ${fuzzy} · 不认识 ${newCount}</div>
      <div class="vocab-quiz-actions">
        <button class="enhance-btn" type="button" id="vocabQuizAgain">再来一轮</button>
        <button class="enhance-btn" type="button" id="vocabQuizExit">退出自测</button>
      </div>
    `;
    quizEl.appendChild(frame);
    frame.querySelector("#vocabQuizAgain").addEventListener("click", () => {
      startVocabQuiz();
    });
    frame.querySelector("#vocabQuizExit").addEventListener("click", () => {
      exitVocabQuiz();
      refreshVocabHighlightIndex();
      refreshVocabHighlights();
    });
    return;
  }

  const question = vocabQuizState.questions[vocabQuizState.index];
  const total = vocabQuizState.questions.length;
  const number = vocabQuizState.index + 1;

  frame.innerHTML = `
    <div class="vocab-quiz-progress">${number} / ${total}
      <button class="vocab-quiz-cancel" type="button">退出</button>
    </div>
    <div class="vocab-quiz-prompt">${
      question.hasContext
        ? escapeHtml(question.prompt)
        : `该词条暂无原句：${escapeHtml(question.entry.text)}`
    }</div>
    ${question.hint ? `<div class="vocab-quiz-hint">提示：${escapeHtml(question.hint)}</div>` : ""}
    <div class="vocab-quiz-reveal" hidden>
      <div class="vocab-quiz-answer">${escapeHtml(question.entry.text)}</div>
      ${question.entry.contextEn ? `<div class="vocab-quiz-sentence">${escapeHtml(question.entry.contextEn)}</div>` : ""}
    </div>
    <div class="vocab-quiz-actions">
      <button class="enhance-btn" type="button" id="vocabQuizReveal">显示答案</button>
      <span class="vocab-quiz-grades" hidden>
        <button class="vocab-mastery mastery-known" type="button">认识</button>
        <button class="vocab-mastery mastery-fuzzy" type="button">模糊</button>
        <button class="vocab-mastery mastery-new" type="button">不认识</button>
      </span>
    </div>
  `;
  quizEl.appendChild(frame);

  const revealBox = frame.querySelector(".vocab-quiz-reveal");
  const grades = frame.querySelector(".vocab-quiz-grades");
  frame.querySelector("#vocabQuizReveal").addEventListener("click", () => {
    revealBox.hidden = false;
    grades.hidden = false;
    frame.querySelector("#vocabQuizReveal").disabled = true;
  });
  frame.querySelector(".vocab-quiz-cancel").addEventListener("click", () => {
    exitVocabQuiz();
  });
  grades
    .querySelectorAll(".vocab-mastery")
    .forEach((button) =>
      button.addEventListener("click", () => {
        const map = { 认识: "known", 模糊: "fuzzy", 不认识: "new" };
        void gradeVocabQuizQuestion(map[button.textContent]);
      }),
    );
}
```

Wire buttons in `setupVocabTabControls` (Task 7):

```js
  document
    .getElementById("vocabExportCsvBtn")
    ?.addEventListener("click", exportVocabCsv);
  document
    .getElementById("vocabExportAnkiBtn")
    ?.addEventListener("click", exportVocabAnki);
  document
    .getElementById("vocabQuizBtn")
    ?.addEventListener("click", startVocabQuiz);
```

- [ ] **Step 4: Run all tests** — Run: `npm test` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add sidepanel.js tests/vocab-wiring.test.js
git commit -m "feat(vocab): CSV/Anki export and cloze quiz with mastery grading"
```

---

### Task 10: CSS + README + full verification

**Files:**
- Modify: `sidepanel.css`, `README.md`, `README.zh-CN.md`

**Interfaces:** none (presentation + docs).

- [ ] **Step 1: Append CSS to `sidepanel.css`**

```css
/* ============================================================
   VOCAB NOTEBOOK (单词本)
   ============================================================ */

mark.vocab-highlight {
  background: rgba(255, 193, 7, 0.25);
  color: inherit;
  border-bottom: 2px solid rgba(240, 168, 0, 0.85);
  border-radius: 2px;
  padding: 0 1px;
}

.cross-highlight-target {
  background: rgba(66, 133, 244, 0.18);
  border-radius: 3px;
}

/* Selection card (extends .explain-tooltip) */
.explain-tooltip .selection-term-row {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 320px;
}
.explain-tooltip .selection-term {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.explain-tooltip .selection-speak-btn {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 14px;
  padding: 2px 4px;
}
.explain-tooltip .selection-meaning {
  font-size: 12px;
  line-height: 1.4;
  max-width: 320px;
  white-space: normal;
  color: var(--text-muted, #666);
  margin: 2px 0 6px;
}
.explain-tooltip .selection-meaning.pending {
  opacity: 0.7;
}
.explain-tooltip .selection-meaning.error {
  color: #d93025;
  cursor: pointer;
  text-decoration: underline;
}
.explain-tooltip .selection-actions {
  display: flex;
  gap: 6px;
}
.explain-tooltip .selection-save-btn {
  background: #1a73e8;
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.explain-tooltip .selection-save-btn:disabled {
  opacity: 0.7;
  cursor: default;
}

/* Vocab tab */
.vocab-section-header {
  flex-wrap: wrap;
  gap: 6px;
}
.vocab-count {
  color: var(--text-muted, #666);
  font-weight: 400;
  font-size: 12px;
}
.vocab-tools {
  display: flex;
  gap: 6px;
}
.vocab-filters {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: 8px 0;
}
.vocab-filter-sep {
  width: 1px;
  height: 16px;
  background: var(--border, #ddd);
}
.vocab-item {
  border: 1px solid var(--border, #ddd);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.vocab-term-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vocab-term {
  font-weight: 700;
  font-size: 15px;
}
.vocab-lang-badge {
  font-size: 10px;
  border: 1px solid var(--border, #ddd);
  border-radius: 3px;
  padding: 1px 4px;
  color: var(--text-muted, #666);
}
.vocab-speak-btn {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 14px;
  padding: 2px;
}
.vocab-meaning {
  font-size: 13px;
  margin: 4px 0;
}
.vocab-context {
  background: rgba(0, 0, 0, 0.03);
  border-radius: 6px;
  padding: 6px 8px;
  margin: 6px 0;
  font-size: 12px;
  line-height: 1.5;
}
.vocab-context-zh {
  color: var(--text-muted, #666);
}
.vocab-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-muted, #666);
}
.vocab-timestamp {
  border: none;
  background: none;
  color: #1a73e8;
  cursor: pointer;
  padding: 0;
  font-size: 11px;
}
.vocab-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
  align-items: center;
}
.vocab-mastery {
  border: 1px solid var(--border, #ddd);
  border-radius: 4px;
  background: none;
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
}
.vocab-mastery.mastery-new {
  color: #d93025;
  border-color: rgba(217, 48, 37, 0.4);
}
.vocab-mastery.mastery-fuzzy {
  color: #e37400;
  border-color: rgba(227, 116, 0, 0.4);
}
.vocab-mastery.mastery-known {
  color: #188038;
  border-color: rgba(24, 128, 56, 0.4);
}
.vocab-delete {
  border: none;
  background: none;
  color: var(--text-muted, #666);
  cursor: pointer;
  font-size: 12px;
}
.vocab-delete:hover {
  color: #d93025;
}
.muted {
  color: var(--text-muted, #999);
}

/* Quiz */
.vocab-quiz-frame {
  border: 1px solid var(--border, #ddd);
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 10px;
}
.vocab-quiz-progress {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-muted, #666);
  margin-bottom: 10px;
}
.vocab-quiz-cancel {
  border: none;
  background: none;
  color: #1a73e8;
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
.vocab-quiz-prompt {
  font-size: 14px;
  line-height: 1.6;
  margin-bottom: 8px;
}
.vocab-quiz-hint {
  font-size: 12px;
  color: var(--text-muted, #666);
  margin-bottom: 8px;
}
.vocab-quiz-answer {
  font-weight: 700;
  font-size: 15px;
  margin-bottom: 4px;
}
.vocab-quiz-sentence {
  font-size: 12px;
  color: var(--text-muted, #666);
}
.vocab-quiz-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
}
.vocab-quiz-grades {
  display: inline-flex;
  gap: 6px;
}
.vocab-quiz-score {
  font-size: 14px;
  margin: 10px 0;
}
.vocab-quiz-title {
  font-weight: 700;
}
```

- [ ] **Step 2: Update README feature lists**

Add to both READMEs (English + 中文): vocab notebook bullet points — selection card with dictionary lookup, save with context, 单词本 tab, mastery, re-appearance highlight, cross-highlight, listen-back, speak, export CSV/Anki, cloze quiz. Keep each README's existing tone and structure; add to "Use YouTube Digest"/使用 steps and "What works today" sections.

- [ ] **Step 3: Full verification**

Run: `npm test`
Expected: all PASS.

Manual smoke checklist (documented for the user, not automated):
- Load unpacked in chrome://extensions, open a captioned video, open panel.
- 双语模式: select an English word → card with 翻译中… → meaning appears → 收藏到单词本 → Saved ✓.
- Select a full English sentence → Chinese meaning appears instantly (cache).
- Select English → counterpart Chinese line highlights; dismiss clears it.
- 单词本 tab shows entry; click ▶ timestamp → jumps back; 🔊 speaks; mastery cycles; delete works.
- Re-open the same video: saved word shows amber underline in transcript.
- 自测 → cloze works, grading updates mastery; CSV/Anki download.

- [ ] **Step 4: Commit**

```bash
git add sidepanel.css README.md README.zh-CN.md
git commit -m "feat(vocab): styles and documentation for the vocab notebook"
```

---

## Final Verification (whole plan)

- [ ] `npm test` green (original 7 test files + 5 new vocab files).
- [ ] `npm run check` (release consistency) — no manifest/version changes were made; should pass unchanged.
- [ ] `git log --oneline` shows one commit per task on top of the baseline.
