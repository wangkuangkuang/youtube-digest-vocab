/**
 * Shared study-workflow logic for the dictation drill (逐句听写).
 *
 * Pure functions only — no DOM, no chrome.* — so the side panel (script tag)
 * and node --test (require) share one implementation. Follows vocab.js.
 *
 * Two responsibilities:
 *   1. Cutting a video into study segments (章节聚合 or 时间切块).
 *   2. Grading a typed sentence against the reference sentence (逐词 diff).
 */
var YTD_STUDY = (() => {
  const DEFAULT_MAX_SECONDS = 1200; // 20 minutes, the study-flow chunk size
  const MIDDLE_DOT = "\u00B7";
  const EN_DASH = "\u2013";

  function rangeTitle(index, start, end) {
    return `Segment ${index} ${MIDDLE_DOT} ${formatClock(start)}${EN_DASH}${formatClock(end)}`;
  }

  // ============================================================
  // CLOCK / SEGMENT HELPERS
  // ============================================================

  function toFiniteSeconds(value) {
    if (
      value === null ||
      value === undefined ||
      value === "" ||
      typeof value === "boolean"
    ) {
      return null;
    }
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  /** Accepts either a raw number or {startSeconds|start|startTime}. */
  function readStartSeconds(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return toFiniteSeconds(value);
    if (typeof value === "string" && value.trim()) return toFiniteSeconds(value);
    return (
      toFiniteSeconds(value.startSeconds) ??
      toFiniteSeconds(value.start) ??
      toFiniteSeconds(value.startTime)
    );
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${minutes}:${String(secs).padStart(2, "0")}`;
  }

  function normalizeChapters(chapters) {
    const list = [];
    (Array.isArray(chapters) ? chapters : []).forEach((chapter, index) => {
      if (!chapter) return;
      const start = readStartSeconds(
        chapter.startSeconds !== undefined ? chapter.startSeconds : chapter,
      );
      if (start === null) return;
      const title = String(chapter.title || "").trim() || `章节 ${index + 1}`;
      list.push({ title, startSeconds: start });
    });
    list.sort((a, b) => a.startSeconds - b.startSeconds);
    return list;
  }

  function normalizeTranscriptSegments(segments) {
    const list = [];
    (Array.isArray(segments) ? segments : []).forEach((segment) => {
      const start = readStartSeconds(segment);
      if (start === null) return;
      list.push({
        startSeconds: start,
        text: String((segment && segment.text) || "").trim(),
      });
    });
    list.sort((a, b) => a.startSeconds - b.startSeconds);
    return list;
  }

  /**
   * Rebuilds one contiguity contract from raw boundaries: sorted, no gaps, no
   * overlaps, and indices are 1-based so they match the "Segment N" titles.
   */
  function finalizeSegments(boundaries) {
    const cleaned = boundaries
      .filter((boundary) => boundary.endSeconds > boundary.startSeconds)
      .sort((a, b) => a.startSeconds - b.startSeconds);
    cleaned.forEach((boundary, index) => {
      const next = cleaned[index + 1];
      if (next) boundary.endSeconds = next.startSeconds;
    });
    return cleaned.map((boundary, index) => ({
      index: index + 1,
      title: boundary.title,
      startSeconds: boundary.startSeconds,
      endSeconds: boundary.endSeconds,
    }));
  }

  /** Chunk text for the dictation "本段" target: every line inside the range. */
  function segmentTextForRange(transcriptSegments, startSeconds, endSeconds) {
    const start = toFiniteSeconds(startSeconds) ?? 0;
    const end = toFiniteSeconds(endSeconds);
    return normalizeTranscriptSegments(transcriptSegments)
      .filter(
        (segment) =>
          segment.startSeconds >= start &&
          (end === null || segment.startSeconds < end),
      )
      .map((segment) => segment.text)
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  /** Index (1-based) of the segment containing `seconds`, else -1. */
  function activeSegmentIndex(segments, seconds) {
    const time = toFiniteSeconds(seconds);
    if (time === null) return -1;
    const hit = (Array.isArray(segments) ? segments : []).find(
      (segment) =>
        segment &&
        time >= Number(segment.startSeconds) &&
        time < Number(segment.endSeconds),
    );
    return hit ? Number(hit.index) : -1;
  }

  // ============================================================
  // SEGMENTATION
  // ============================================================

  /**
   * Cuts a video into study segments no longer than `maxSeconds`.
   *
   * Preferred input is YouTube's own chapters: consecutive chapters are merged
   * while the merged span still fits, and the merged segment keeps the first
   * chapter's title. Without chapters we chunk the transcript by time and name
   * each chunk `Segment 2 · 24:10–41:33`.
   *
   * @param {Object} input
   * @param {Array} [input.chapters] - [{title, startSeconds}]
   * @param {Array} [input.transcriptSegments] - [{text, start}]
   * @param {number} [input.maxSeconds=1200]
   * @returns {Array<{index:number,title:string,startSeconds:number,endSeconds:number}>}
   */
  function splitIntoSegments({
    chapters,
    transcriptSegments,
    maxSeconds = DEFAULT_MAX_SECONDS,
  } = {}) {
    const max =
      Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
        ? Number(maxSeconds)
        : DEFAULT_MAX_SECONDS;
    const normalizedTranscript = normalizeTranscriptSegments(transcriptSegments);
    // The last caption start is the only end we can trust: a video can have
    // silent outro, so player duration would create a long empty tail block.
    const contentEnd = normalizedTranscript.length
      ? normalizedTranscript[normalizedTranscript.length - 1].startSeconds
      : 0;
    const chapterList = normalizeChapters(chapters);

    if (chapterList.length) {
      const boundaries = [];
      if (chapterList[0].startSeconds > 1) {
        boundaries.push({
          title: rangeTitle(1, 0, chapterList[0].startSeconds),
          startSeconds: 0,
          endSeconds: chapterList[0].startSeconds,
        });
      }
      chapterList.forEach((chapter, index) => {
        const next = chapterList[index + 1];
        const endSeconds = next
          ? next.startSeconds
          : Math.max(chapter.startSeconds, contentEnd);
        boundaries.push({
          title: chapter.title,
          startSeconds: chapter.startSeconds,
          endSeconds,
        });
      });

      const merged = [];
      let current = null;
      boundaries.forEach((boundary) => {
        if (!current) {
          current = { ...boundary };
          return;
        }
        if (boundary.endSeconds - current.startSeconds <= max) {
          current.endSeconds = boundary.endSeconds;
          return;
        }
        merged.push(current);
        current = { ...boundary };
      });
      if (current) merged.push(current);
      if (merged.length) return finalizeSegments(merged);
    }

    if (!normalizedTranscript.length) return [];

    // Boundaries land on caption starts, so a chunk never exceeds the cap
    // unless the video itself has a caption gap wider than the cap (then the
    // gap wins: splitting it would only create a content-free block).
    const chunks = [];
    let chunkStart = null;
    let lastStart = null;
    normalizedTranscript.forEach((segment) => {
      if (chunkStart === null) {
        // Cover the video from the top even when the captions start late.
        chunkStart = segment.startSeconds > 1 ? 0 : segment.startSeconds;
        lastStart = segment.startSeconds;
        return;
      }
      if (
        segment.startSeconds - chunkStart > max &&
        lastStart > chunkStart
      ) {
        chunks.push({ startSeconds: chunkStart, endSeconds: lastStart });
        chunkStart = lastStart;
      }
      lastStart = segment.startSeconds;
    });
    chunks.push({
      startSeconds: chunkStart === null ? 0 : chunkStart,
      endSeconds: Math.max(lastStart ?? 0, contentEnd),
    });

    return finalizeSegments(
      chunks.map((chunk, index) => ({
        title: rangeTitle(index + 1, chunk.startSeconds, chunk.endSeconds),
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
      })),
    );
  }

  // ============================================================
  // DICTATION DIFF (逐词批改)
  // ============================================================

  /**
   * Lowercases, removes punctuation (including hyphens, so `well-known` and
   * `well known` agree), collapses whitespace and trims. Apostrophes survive,
   * so `don't` is one token and can never silently match `do not`; that pair
   * is graded as a wrong word, which is the honest result for a dictation
   * drill. Nothing smarter than that on purpose.
   */
  function normalizeDictationText(text) {
    return String(text === undefined || text === null ? "" : text)
      .toLowerCase()
      .replace(/[\u2018\u2019\u02BC\u00B4`]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[^a-z0-9'\u00C0-\u024F\u3400-\u9FFF\uF900-\uFAFF]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenizeDictation(text) {
    const normalized = normalizeDictationText(text);
    return normalized ? normalized.split(" ") : [];
  }

  function lcsOps(expected, actual) {
    const n = expected.length;
    const m = actual.length;
    const table = [];
    for (let i = 0; i <= n; i += 1) table.push(new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i][j] =
          expected[i] === actual[j]
            ? table[i + 1][j + 1] + 1
            : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }

    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (expected[i] === actual[j]) {
        ops.push({ kind: "equal", expected: expected[i], actual: actual[j] });
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        ops.push({ kind: "delete", expected: expected[i] });
        i += 1;
      } else {
        ops.push({ kind: "insert", actual: actual[j] });
        j += 1;
      }
    }
    while (i < n) {
      ops.push({ kind: "delete", expected: expected[i] });
      i += 1;
    }
    while (j < m) {
      ops.push({ kind: "insert", actual: actual[j] });
      j += 1;
    }
    return ops;
  }

  /**
   * Word-level comparison of the reference sentence and what was typed.
   *
   * Tokens are `{type, expected?, actual?}`:
   *   equal   — matched
   *   wrong   — expected word replaced by a different typed word (橙底)
   *   missing — expected word not typed (漏写 / 红底删除线)
   *   extra   — typed word not in the sentence (多写 / 灰底删除线)
   *
   * `accuracy` is the 0..1 ratio of matched reference words; `accuracyPercent`
   * is that rounded to an integer for display and storage.
   */
  function diffWords(expectedText, actualText) {
    const expected = tokenizeDictation(expectedText);
    const actual = tokenizeDictation(actualText);
    const ops = lcsOps(expected, actual);
    const tokens = [];

    let pendingExpected = [];
    let pendingActual = [];
    const flush = () => {
      const pairs = Math.min(pendingExpected.length, pendingActual.length);
      for (let k = 0; k < pairs; k += 1) {
        tokens.push({
          type: "wrong",
          expected: pendingExpected[k],
          actual: pendingActual[k],
        });
      }
      for (let k = pairs; k < pendingExpected.length; k += 1) {
        tokens.push({ type: "missing", expected: pendingExpected[k] });
      }
      for (let k = pairs; k < pendingActual.length; k += 1) {
        tokens.push({ type: "extra", actual: pendingActual[k] });
      }
      pendingExpected = [];
      pendingActual = [];
    };

    ops.forEach((op) => {
      if (op.kind === "equal") {
        flush();
        tokens.push({ type: "equal", expected: op.expected, actual: op.actual });
        return;
      }
      if (op.kind === "delete") pendingExpected.push(op.expected);
      else pendingActual.push(op.actual);
    });
    flush();

    let correct = 0;
    let wrongCount = 0;
    let missingCount = 0;
    let extraCount = 0;
    tokens.forEach((token) => {
      if (token.type === "equal") correct += 1;
      else if (token.type === "wrong") wrongCount += 1;
      else if (token.type === "missing") missingCount += 1;
      else extraCount += 1;
    });

    const total = expected.length;
    const accuracy = total ? correct / total : 0;
    return {
      tokens,
      total,
      actualTotal: actual.length,
      correct,
      wrongCount,
      missingCount,
      extraCount,
      // 错词数 = everything the learner got wrong on the reference side.
      mistakeCount: wrongCount + missingCount,
      accuracy,
      accuracyPercent: Math.round(accuracy * 100),
    };
  }

  // ============================================================
  // PLAYBACK SPEED (听写降速档位)
  // ============================================================

  /**
   * The gears the speed control steps through. Dense at the slow end, where
   * dictation needs it, and sparse at the fast end, which is only used for
   * re-listening to something already understood.
   */
  const PLAYBACK_RATES = [0.5, 0.6, 0.75, 0.9, 1, 1.25, 1.5, 2];
  const MIN_PLAYBACK_RATE = PLAYBACK_RATES[0];
  const MAX_PLAYBACK_RATE = PLAYBACK_RATES[PLAYBACK_RATES.length - 1];
  const DEFAULT_PLAYBACK_RATE = 1;

  /**
   * Clamps a requested speed into the supported range. Missing, empty and
   * non-numeric input collapse to normal speed instead of leaking NaN into
   * the player.
   */
  function clampPlaybackRate(rate) {
    if (
      rate === null ||
      rate === undefined ||
      rate === "" ||
      typeof rate === "boolean"
    ) {
      return DEFAULT_PLAYBACK_RATE;
    }
    const value = Number(rate);
    if (!Number.isFinite(value)) return DEFAULT_PLAYBACK_RATE;
    return Math.min(Math.max(value, MIN_PLAYBACK_RATE), MAX_PLAYBACK_RATE);
  }

  /**
   * Index of the gear closest to `rate`, so a speed set somewhere else
   * (YouTube's own menu) still steps from a sane place. Ties pick the slower
   * gear, which is the safe direction for a dictation drill.
   */
  function nearestRateIndex(rate) {
    const value = clampPlaybackRate(rate);
    let best = 0;
    let bestDistance = Infinity;
    PLAYBACK_RATES.forEach((gear, index) => {
      const distance = Math.abs(gear - value);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }

  /**
   * One gear up (`direction > 0`) or down (`direction < 0`) from `current`.
   * At either end the gear stops, unless `wrap` is set: that is what the
   * toolbar click needs to cycle through every speed with one button.
   */
  function nextRate(current, direction = 1, { wrap = false } = {}) {
    const index = nearestRateIndex(current);
    const step = Number(direction) < 0 ? -1 : 1;
    const target = index + step;
    if (target < 0 || target >= PLAYBACK_RATES.length) {
      if (!wrap) return PLAYBACK_RATES[index];
      return step > 0
        ? PLAYBACK_RATES[0]
        : PLAYBACK_RATES[PLAYBACK_RATES.length - 1];
    }
    return PLAYBACK_RATES[target];
  }

  /** Display form: `1` -> `"1×"`, `0.75` -> `"0.75×"`, junk -> `"1×"`. */
  function formatRate(rate) {
    return `${clampPlaybackRate(rate)}×`;
  }

  return {
    DEFAULT_MAX_SECONDS,
    PLAYBACK_RATES,
    clampPlaybackRate,
    nextRate,
    formatRate,
    formatClock,
    normalizeDictationText,
    tokenizeDictation,
    diffWords,
    splitIntoSegments,
    segmentTextForRange,
    activeSegmentIndex,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_STUDY;
}
