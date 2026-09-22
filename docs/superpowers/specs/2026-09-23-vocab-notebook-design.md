# Vocab Notebook (单词本) — Design Spec

Date: 2026-09-23
Project: YouTube Digest 二创 — English-learning edition
Status: Pending user review

## 1. Goal & Background

Turn YouTube Digest into an English-learning tool by adding a vocabulary
notebook closed loop: **select → translation card → save to notebook →
bilingual sentence-level cross-highlight → re-appearance highlighting →
review (list / listen-back / quiz / export)**.

The primary collection entry is a dictionary-style lookup: selecting a
word/phrase/sentence in the transcript opens a card showing its meaning
(cached sentence translation when available, otherwise one small AI
dictionary call), with a Save button on the card.

Out of scope (explicitly deferred by user decision, 2026-09-23):

- Word-level EN↔ZH cross-highlight (sentence-level only for now)
- Inflection matching for re-appearance highlight (exact match only)

The ONLY AI addition is the selection dictionary lookup (§4.2); everything
else is local with zero API cost. Sentences reuse cached translations for
free.

## 2. Current-Code Facts This Design Relies On

| Fact | Location | Used for |
|---|---|---|
| Selection toolbar with Explain/Note buttons on transcript selection | `sidepanel.js setupExplainFeature()` | Refactor into unified selection card (Explain/Note move in, lookup + Save added) |
| Selection→AI-call precedent: `handleExplainSelection` → `requestAiCompletion` (JSON mode, non-thinking, timeouts) + prompt files loaded via `loadPromptSection` | `background.js`, `prompts/*.md` | `lookupVocabMeaning` reuses this exact pattern |
| Bilingual rows: `.transcript-entry > .transcript-copy > .transcript-original (EN) + .transcript-translation (ZH)` | `renderTranscriptSegmentContent()` | Sentence-level cross-highlight via sibling lookup |
| Transcripts render via `renderTranscriptModeRows()`, then search refresh hooks in; translation arrival replaces row content via `updateTranslatedRow()` | `sidepanel.js` | Vocab highlight re-apply hooks (same places search uses) |
| Search highlight wraps text nodes in `mark.transcript-search-highlight` | `sidepanel.js ~L1132-1230` | Shared text-node-walking pattern; vocab marks must coexist |
| Notes storage pattern: `ytd_notes` array in `chrome.storage.local`, handlers `saveNote/getNotes/deleteNote` routed via `chrome.runtime.onMessage` | `background.js` | Same pattern for `ytd_vocab` |
| `seekTo(seconds)` works from sidepanel through background relay to content script | `sidepanel.js L1559`, `content.js L151` | Listen-back (回听) from vocab entries |
| Tab system: `.tab[data-tab]` buttons + `.tab-panel[data-panel]`, `switchTab()` | `sidepanel.html`, `sidepanel.js switchTab()` | 4th tab "Vocab" |
| Notes tab UI pattern (filter buttons This Video/All, list rendering) | `sidepanel.html`, `renderNotes()` | Vocab tab layout follows it |
| Plain module importable by both pages and tests | `settings.js` | New `vocab.js` shared module |

## 3. Data Model

Storage key: `ytd_vocab` in `chrome.storage.local`. Array, newest first,
capped at 2000 entries (overflow drops oldest, like notes' 100-cap pattern).

```js
{
  id: string,                  // crypto.randomUUID()
  text: string,                // the selected term/phrase/sentence (trimmed)
  language: "en" | "zh",       // which span the selection was made in
  meaning: string,             // dictionary-style translation captured at collect time (may be "")
  contextEn: string,           // full EN text of the first row involved ("" if unavailable)
  contextZh: string,           // full ZH text of that row ("" if translation pending at collect time)
  videoId: string,
  videoTitle: string,
  timestampSeconds: number,    // first involved row's start
  mastery: "new" | "fuzzy" | "known",   // 未掌握 / 模糊 / 掌握
  createdAt: number,
}
```

Dedup rule: same `text` + same `language` already exists → no duplicate;
collect button shows "Already saved" feedback.

Context capture rule: at most the first involved row's full EN/ZH text
(single sentence pair). Multi-row selections still save only the first
row's sentence as context (keeps entries small and sentences meaningful).

## 4. Components

### 4.1 `vocab.js` — new shared pure-logic module (settings.js pattern)

Imported by `sidepanel.html` (`<script src="vocab.js">`) and by tests.

- `buildVocabIndex(entries)` →
  `{ wordSet: Map<lowercasedWord, entryId>, phrases: [{pattern, entryId}] }`
  — single words (no spaces) go into the word map; multi-word phrases get
  case-insensitive, whitespace-normalized regex with word boundaries
  (Latin) or plain substring (CJK, no `\b` support).
- `findVocabMatches(textNodeValue, index, textIsEnglish)` → array of
  `{ start, end, entryId }` ranges for one text node.
- `shouldHighlightEntry(entry, opts)` → mastery filter (`known` excluded
  unless user setting `highlightKnown` is on, default off).
- `generateClozeQuestions(entries, count)` → shuffle, pick N from
  `new`+`fuzzy` first (fall back to all), each
  `{ entry, prompt: sentence with first occurrence of term replaced by
  "______", hint: meaning || contextZh }`. Case-insensitive blanking; if term not
  found verbatim in contextEn (e.g. user selected across rows), fall back
  to showing term as-is with a "context unavailable" prompt.
- `toCsv(entries)` / `toAnkiTsv(entries)` → proper escaping
  (CSV: quote+double quotes; TSV: tab-join, strip tabs/newlines in fields).
- `dedupeExisting(existingEntries, text, language)` → entry id or null.
- `resolveMeaningSource(selectionText, rowEnText, rowZhText)` →
  `"cache" | "ai"` — if the selection (whitespace-normalized, case-insensitive)
  covers ≈ the full EN row text and a cached ZH exists, the row's ZH IS the
  meaning (free); otherwise one AI dictionary lookup.

### 4.2 `background.js` — storage handlers (notes pattern)

New actions routed in the existing `onMessage` dispatcher:

- `saveVocabEntry(entry)` → unshift, cap 2000, set storage → `{success}`
- `getVocabEntries({videoId?})` → filtered array
- `updateVocabEntry({id, patch})` → mastery updates (and any future field)
- `deleteVocabEntry(id)`
- `lookupVocabMeaning({ text, contextEn, videoTitle })` → one small
  dictionary-style AI call via `requestAiCompletion` (JSON mode,
  non-thinking, `maxTokens ≈ 300`), using new prompt file
  `prompts/vocab-lookup.md` (same `loadPromptSection` convention as
  explain/translation). Prompt contract: input = selected text + context
  sentence + video title; output = strict JSON
  `{"meaning": "…"}` where meaning is a concise dictionary entry — single
  word: phonetic + POS + gloss (`/rʌn/ v. 跑；运转；经营`); phrase:
  paraphrase; sentence: full translation. Only AI addition in this design;
  cost ≈ a few hundred tokens per lookup.

### 4.3 Selection card: lookup + collect + cross-highlight — `sidepanel.js`

**Replaces the current Explain/Note toolbar** with one unified card
(`setupExplainFeature` refactored; Explain and Note buttons move into the
card, their behavior unchanged):

1. On selection `mouseup` inside the transcript (existing detection logic),
   the card appears at the selection immediately — no debounce on showing
   the card itself.
2. Card contents:
   - Line 1: selected term (truncated) + 🔊 speak
   - Line 2: meaning — `resolveMeaningSource()`: full-sentence selection
     with cached row ZH → show it instantly (free); otherwise
     `翻译中…` then `lookupVocabMeaning` result fills in (AI call fired
     immediately on card show; the debounce guards accidental re-fires
     via a 700ms selection-stable check before auto-lookup, and selection
     length must be ≤ 200 chars, else the meaning line is omitted)
   - Buttons: [收藏到单词本] (primary), [Explain], [Note]
3. On Save (收藏): resolve rows, `language` from anchor span class
   (`transcript-original` → "en", `transcript-translation` → "zh",
   ambiguous → "en"); context = first row's full EN/ZH textContent (ZH via
   cache lookup if the span still shows "Waiting for translation…" →
   store ""); `meaning` = whatever the card currently shows (may be "").
   Dedup on text+language → "Already saved" feedback instead of a new
   entry. Refresh vocab tab badge + list if visible. Auto-speak the
   collected term once (feature-detect speechSynthesis).

**Sentence-level cross-highlight** (bilingual mode only): when the card
shows for a selection lying entirely within one language's spans across
one or more rows → add class `.cross-highlight-target` to the counterpart
span(s) of every row the selection touches. Clear all such classes on
card dismissal (`dismissSelectionActions()`), before applying a new
selection's highlight. No-op outside bilingual mode.

### 4.4 Re-appearance highlight engine — `sidepanel.js`

- `applyVocabHighlights(root)`: walks text nodes (skipping any node inside
  a `mark` of either class, so vocab and search marks never nest), wraps
  matches in `<mark class="vocab-highlight" data-vocab-id>`.
  EN spans only (`language === "en"` entries match EN text; `zh` entries
  match ZH spans — both supported, same engine).
- `clearVocabHighlights(root)`: unwrap all `mark.vocab-highlight`.
- Hooks: end of `renderTranscriptModeRows()` (after search refresh), and
  after each `updateTranslatedRow()` content replacement. Vocab index
  rebuilt on: video load, tab switches back to transcript, any vocab
  save/update/delete.
- Coexistence with search: each highlighter only wraps bare text nodes
  outside existing marks; clearing one never touches the other's marks.

### 4.5 Vocab tab — `sidepanel.html` + `sidepanel.js` + `sidepanel.css`

4th tab `Vocab 单词本` (label: "单词本"). Panel contents:

- Header row: count badge, mastery filter buttons (全部 / 未掌握 / 模糊 /
  已掌握), video filter (本视频 / 全部, notes pattern), Export CSV, Export
  Anki, Start Quiz (开始自测).
- List items (newest first), each showing:
  - Term (bold, larger) + 🔊 speak button + language badge (EN/ZH)
  - Meaning line (the dictionary entry captured at collect time; muted
    "（无释义）" when empty)
  - Context card: EN sentence with collected term wrapped in
    `.vocab-highlight`; ZH sentence below (muted)
  - Meta line: video title (title attr), timestamp link `m:ss` →
    `seekTo(entry.timestampSeconds)`, created date
  - Mastery cycle button (new→fuzzy→known, colored), delete button
- Empty state text; buttons disabled when list empty.
- Vocab marks inside the current transcript get a tooltip
  (`title="已收藏"`) — no click handler needed for v1.

### 4.6 Listen-back (回听)

Timestamp link on each entry calls existing `seekTo()`. Also switches to
transcript tab first so the sentence is visible, then seeks.

### 4.7 Pronunciation

`vocabSpeak(text, lang)`: `window.speechSynthesis` with
`utterance.lang = "en-US" | "zh-CN"`, cancel-then-speak. Feature-detect;
hide 🔊 buttons when unavailable. Used on vocab items and optionally on
collect (speak the collected term once — default on, no extra setting for
v1).

### 4.8 Export

- CSV columns: `term, language, contextEn, contextZh, videoTitle, videoUrl
  (https://youtu.be/{videoId}?t={floor(timestampSeconds)}), mastery,
  createdAt (ISO)`. Filename `youtube-digest-vocab-YYYYMMDD.csv`.
- Anki TSV: front = `term<br>contextEn (term <b>bold</b>)`, back =
  `contextZh<br>source: videoTitle`. Escaped per Anki import rules.
- Both via Blob + object URL + temporary anchor click in the sidepanel.

### 4.9 Cloze quiz (挖空自测)

In-panel quiz mode replacing the vocab list while active (Cancel button
exits, restores list):

1. `generateClozeQuestions(filteredEntries, 10)`.
2. Per question: prompt sentence with `______`, hint = `meaning` if
   non-empty else `contextZh`, "显示答案" reveals the term + original
   sentence.
3. Self-grade buttons 认识 / 模糊 / 不认识 → `updateVocabEntry` mastery
   (known / fuzzy / new).
4. Progress `3/10`; end screen with per-grade counts and "再来一轮".

## 5. Error Handling & Edge Cases

| Case | Behavior |
|---|---|
| Translation pending at collect time | `contextZh: ""`, vocab item shows muted "（翻译未就绪）" |
| Meaning lookup fails / times out | Card shows "释义获取失败，点击重试"; Save still allowed with `meaning: ""` |
| Selection cleared before AI returns | Stale lookup result discarded (generation counter, like translation batches) |
| Selection > 200 chars | Card shows without meaning line (sentence ZH cache path still applies) |
| Selection spans EN+ZH in same row | language = "en" (anchor side), context from that row |
| Collect duplicate | No new entry, card Save button shows "Already saved" |
| `speechSynthesis` missing | Speak buttons hidden |
| Quiz with < 10 eligible | Quiz uses what exists (≥1), else disabled with hint |
| Storage cap 2000 | Drop oldest entries silently (export is the escape valve) |
| Highlight vs search nesting | Both walkers skip nodes inside any `mark`; each clears only its own |
| Vocab highlight re-apply after translation arrives | `updateTranslatedRow` hook re-runs engine on that row |
| Sidepanel on non-video page | Vocab tab still works (list/export/quiz), collect/seek unavailable |

## 6. Testing

New files in `tests/` (node --test, import `vocab.js` like settings tests):

- `vocab-index.test.js` — word vs phrase classification, case
  insensitivity, word boundaries ("run" must not match "running"),
  CJK substring, mastery filter, `resolveMeaningSource`
  (cache-vs-AI decision: full-sentence coverage, whitespace/case
  normalization, missing ZH fallback to "ai").
- `vocab-cloze.test.js` — blanking (first occurrence, case-insensitive),
  fallback when term not in sentence, question count fallback, shuffle
  determinism with seeded input.
- `vocab-export.test.js` — CSV escaping (comma/quote/newline), Anki TSV
  field integrity, URL formatting.
- `vocab-storage.test.js` — dedup logic + cap-2000 trim (pure-function
  part of the handler logic, kept in vocab.js as `applyVocabSave`).

Existing tests must stay green.

## 7. Files Touched

| File | Change |
|---|---|
| `vocab.js` | NEW — pure logic module |
| `background.js` | 4 storage handlers + `lookupVocabMeaning` AI handler + dispatcher routes |
| `prompts/vocab-lookup.md` | NEW — dictionary lookup prompt (loadPromptSection convention) |
| `sidepanel.html` | Vocab tab button + panel markup + `<script src="vocab.js">` |
| `sidepanel.js` | Selection card (lookup/save/explain/note), cross-highlight, highlight engine + hooks, vocab tab rendering, speak, export, quiz |
| `sidepanel.css` | `.vocab-highlight`, `.cross-highlight-target`, toolbar button, vocab list, quiz styles |
| `tests/*.test.js` | 4 new test files |
| `README.md` / `README.zh-CN.md` | Feature documentation |

`content.js`, `manifest.json`, `options.*`, `settings.js`: unchanged.

## 8. Implementation Order (single pass, test-first per unit)

1. `vocab.js` core (index/cloze/export/dedup) + its tests — pure, no UI.
2. Storage handlers in `background.js`.
3. Collect button + context capture + save flow.
4. Vocab tab UI (list, mastery, listen-back, filters).
5. Cross-highlight + re-appearance engine + hooks.
6. Speak + export.
7. Quiz.
8. CSS polish + README.
