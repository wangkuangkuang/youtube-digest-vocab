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
      // CJK text runs are single regex "tokens" to the tokenizer below, so
      // whole-word map lookup can never hit; match CJK by substring instead.
      if (isSingleWord(entry.text) && !hasCJK(entry.text)) {
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
