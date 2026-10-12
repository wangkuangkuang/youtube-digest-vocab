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

  // ——— Spaced repetition (间隔重复) ———
  const SRS_GRADES = Object.freeze(["again", "hard", "good"]);
  const SRS_EASE_DEFAULT = 2.5;
  const SRS_EASE_MIN = 1.3;
  const SRS_EASE_MAX = 2.8;
  const DAY_MS = 86_400_000;

  function readFiniteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clampEase(value) {
    return Math.min(SRS_EASE_MAX, Math.max(SRS_EASE_MIN, value));
  }

  /**
   * Accepts a timestamp in ms, an ISO string or a Date. Missing/invalid input
   * falls back to now so callers can omit it.
   */
  function toMillis(value) {
    if (value === undefined || value === null) return Date.now();
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isFinite(time) ? time : Date.now();
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : Date.now();
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  /** Missing or unparsable `due` means "needs review now". */
  function dueTime(entry) {
    const raw = entry && entry.due;
    if (typeof raw !== "string" || !raw.trim()) return 0;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

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

  /**
   * Picks the most natural speechSynthesis voice for a language.
   * Tiers (cumulative score): exact locale match > language match (others
   * are ignored); Google network voices and Natural/Enhanced/Neural system
   * voices score highest; well-known platform voices score mid; compact /
   * espeak / pico robotic voices are penalized.
   */
  function pickBestVoice(voices, language) {
    const primary = language === "zh" ? "zh-cn" : "en-us";
    const wantPrefix = language === "zh" ? "zh" : "en";
    let best = null;
    let bestScore = -1;
    (voices || []).forEach((voice) => {
      if (!voice || !voice.lang) return;
      const lang = String(voice.lang).replace("_", "-").toLowerCase();
      let score = 0;
      if (lang === primary) score += 40;
      else if (lang.startsWith(wantPrefix)) score += 20;
      else return; // other language — never pick
      const name = String(voice.name || "").toLowerCase();
      if (/google/.test(name)) score += 30;
      if (/natural|neural|enhanced|premium/.test(name)) score += 25;
      if (/samantha|tingting|aria|jenny|guy|sonia|libby|mei-?jia|yu-?shu/.test(name)) score += 15;
      if (/compact|espeak|pico/.test(name)) score -= 20;
      if (voice.localService) score += 5;
      if (voice.default) score += 2;
      if (score > bestScore) {
        best = voice;
        bestScore = score;
      }
    });
    return best;
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
      // SRS fields. Older entries simply lack them and read as "due now"
      // (interval 0) instead of crashing anything.
      due:
        typeof input.due === "string" && input.due.trim()
          ? input.due
          : new Date(Date.now()).toISOString(),
      interval: Math.max(0, readFiniteNumber(input.interval, 0)),
      ease: clampEase(readFiniteNumber(input.ease, SRS_EASE_DEFAULT)),
      reviewCount: Math.max(0, readFiniteNumber(input.reviewCount, 0)),
      lapses: Math.max(0, readFiniteNumber(input.lapses, 0)),
      lastReviewedAt:
        typeof input.lastReviewedAt === "string" ? input.lastReviewedAt : "",
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
    // Cap by dropping the oldest entry (min createdAt), not by position:
    // callers may hand us entries in any order.
    while (next.length > ENTRY_CAP) {
      let oldestIdx = 1;
      for (let i = 1; i < next.length; i++) {
        if ((next[i].createdAt || 0) < (next[oldestIdx].createdAt || 0)) {
          oldestIdx = i;
        }
      }
      next.splice(oldestIdx, 1);
    }
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
      // SRS fields are validated field by field, so a bad patch can never
      // write garbage into storage. The background worker reuses this
      // function, which is how review grades reach the saved entry.
      if (patch) applySrsPatch(merged, patch);
      return merged;
    });
    return { entries: next, updated: updated };
  }

  function applySrsPatch(entry, patch) {
    if (typeof patch.due === "string" && patch.due.trim()) {
      entry.due = patch.due;
    }
    if (patch.interval !== undefined) {
      entry.interval = Math.max(0, readFiniteNumber(patch.interval, entry.interval || 0));
    }
    if (patch.ease !== undefined) {
      entry.ease = clampEase(readFiniteNumber(patch.ease, entry.ease || SRS_EASE_DEFAULT));
    }
    if (patch.reviewCount !== undefined) {
      entry.reviewCount = Math.max(
        0,
        readFiniteNumber(patch.reviewCount, entry.reviewCount || 0),
      );
    }
    if (patch.lapses !== undefined) {
      entry.lapses = Math.max(0, readFiniteNumber(patch.lapses, entry.lapses || 0));
    }
    if (typeof patch.lastReviewedAt === "string") {
      entry.lastReviewedAt = patch.lastReviewedAt;
    }
    return entry;
  }

  /**
   * SM-2, simplified to three grades (忘记 / 模糊 / 认识).
   *
   *   again -> interval 0 (same-day retry), ease -0.2, lapses +1, 未掌握
   *   hard  -> interval max(1, round(interval * 1.2)), 模糊
   *   good  -> interval 1 on the first pass, then round(interval * ease), 已掌握
   *
   * Ease is clamped to [1.3, 2.8], `due` becomes now + interval days, and
   * `reviewCount` always increments. Returns a new entry; the input is never
   * mutated. An unknown grade returns a normalized copy unchanged.
   */
  function applySrsGrade(entry, grade, now) {
    const base = normalizeVocabEntry(entry || {});
    if (!SRS_GRADES.includes(grade)) return base;

    const time = toMillis(now);
    let interval = base.interval;
    let ease = base.ease;
    let lapses = base.lapses;
    let mastery = base.mastery;

    if (grade === "again") {
      interval = 0;
      ease = clampEase(ease - 0.2);
      lapses += 1;
      mastery = "new";
    } else if (grade === "hard") {
      interval = Math.max(1, Math.round(interval * 1.2));
      mastery = "fuzzy";
    } else {
      interval = interval < 1 ? 1 : Math.round(interval * ease);
      mastery = "known";
    }

    return Object.assign(base, {
      interval: interval,
      ease: ease,
      lapses: lapses,
      mastery: mastery,
      reviewCount: base.reviewCount + 1,
      lastReviewedAt: new Date(time).toISOString(),
      due: new Date(time + interval * DAY_MS).toISOString(),
    });
  }

  function isDue(entry, now) {
    return dueTime(entry) <= toMillis(now);
  }

  /** Due entries, most overdue first. Missing `due` counts as due. */
  function dueEntries(entries, now) {
    const time = toMillis(now);
    return (entries || [])
      .filter((entry) => entry && isDue(entry, time))
      .sort((a, b) => dueTime(a) - dueTime(b));
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

  function vocabVideoUrl(entry) {
    const t = Math.max(0, Math.floor(Number(entry && entry.timestampSeconds) || 0));
    return "https://youtu.be/" + (entry && entry.videoId) + "?t=" + t;
  }

  function csvEscape(value) {
    const s = String(value === undefined || value === null ? "" : value);
    if (!/[",\n\r]/.test(s)) return s;
    // Flatten newlines so each record stays on one physical line (naive
    // CSV consumers split on \n); quoting is still decided by the raw value.
    return '"' + s.replace(/[\n\r]/g, " ").replace(/"/g, '""') + '"';
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

  function locateTermInSentence(sentence, term) {
    if (!term || !sentence) return null;
    const lower = sentence.toLowerCase();
    const exact = lower.indexOf(term.toLowerCase());
    if (exact !== -1) return { index: exact, length: term.length };
    // Loose fallback: the saved term may carry quotes the sentence lacks
    // (e.g. term `run, "fast"` vs sentence `run, fast`).
    const loose = term.replace(/["“”「」『』]/g, "").replace(/\s+/g, " ").trim();
    if (!loose) return null;
    const looseIdx = lower.indexOf(loose.toLowerCase());
    return looseIdx === -1 ? null : { index: looseIdx, length: loose.length };
  }

  function toAnkiTsv(entries) {
    return (entries || [])
      .map((e) => {
        const sentence = ankiField(e.contextEn);
        const term = ankiField(e.text);
        let bolded = sentence;
        if (term && sentence) {
          const located = locateTermInSentence(sentence, term);
          if (located) {
            const end = located.index + located.length;
            bolded =
              sentence.slice(0, located.index) +
              "<b>" +
              sentence.slice(located.index, end) +
              "</b>" +
              sentence.slice(end);
          }
        }
        const front = ankiField(e.text) + "<br>" + bolded;
        const back =
          ankiField(e.meaning || e.contextZh) +
          "<br>source: " +
          ankiField(e.videoTitle);
        // `due` is appended last so existing Anki mappings keep their columns.
        return (
          front + "\t" + back + "\t" + ankiField(typeof e.due === "string" ? e.due : "")
        );
      })
      .join("\n");
  }

  return {
    MASTERY_LEVELS,
    MASTERY_LABELS,
    ENTRY_CAP,
    CLOZE_BLANK,
    SRS_GRADES,
    SRS_EASE_DEFAULT,
    SRS_EASE_MIN,
    SRS_EASE_MAX,
    DAY_MS,
    normalizeWhitespace,
    hasCJK,
    isSingleWord,
    pickBestVoice,
    normalizeVocabEntry,
    shouldHighlightEntry,
    buildVocabIndex,
    findVocabMatches,
    dedupeExisting,
    applyVocabSave,
    applyVocabUpdate,
    applyVocabDelete,
    applySrsGrade,
    isDue,
    dueEntries,
    resolveMeaningSource,
    blankFirstOccurrence,
    generateClozeQuestions,
    vocabVideoUrl,
    toCsv,
    toAnkiTsv,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_VOCAB;
}
