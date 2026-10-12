const test = require("node:test");
const assert = require("node:assert/strict");
const study = require("../study.js");

// A dense caption track (one line every 30s) is what Supadata returns in
// practice; sparse tracks are covered separately below.
const dense = Array.from({ length: 61 }, (_, index) => ({
  text: `line ${index}`,
  start: index * 30,
}));

const sparse = [
  { text: "Welcome back.", start: 0 },
  { text: "Today we talk about agents.", start: 300 },
  { text: "They plan and act.", start: 900 },
  { text: "Then they learn from feedback.", start: 1500 },
  { text: "That is the loop.", start: 2700 },
  { text: "See you next time.", start: 3900 },
];

test("channel-less videos are chunked by time, titled with their range", () => {
  const segments = study.splitIntoSegments({
    chapters: [],
    transcriptSegments: dense,
    maxSeconds: 600,
  });

  assert.deepEqual(
    segments.map((s) => [s.index, s.title, s.startSeconds, s.endSeconds]),
    [
      [1, "Segment 1 · 0:00–10:00", 0, 600],
      [2, "Segment 2 · 10:00–20:00", 600, 1200],
      [3, "Segment 3 · 20:00–30:00", 1200, 1800],
    ],
  );
});

test("segment boundaries stay contiguous and never overlap", () => {
  const segments = study.splitIntoSegments({
    chapters: [],
    transcriptSegments: sparse,
    maxSeconds: 600,
  });

  assert.equal(segments[0].startSeconds, 0);
  assert.equal(segments[segments.length - 1].endSeconds, 3900);
  segments.forEach((segment, index) => {
    assert.ok(segment.endSeconds > segment.startSeconds, "no empty segment");
    if (index > 0) {
      assert.equal(segment.startSeconds, segments[index - 1].endSeconds);
    }
  });
});

test("a caption gap wider than the cap is not split into an empty block", () => {
  const segments = study.splitIntoSegments({
    chapters: [],
    transcriptSegments: sparse,
    maxSeconds: 600,
  });

  // 1500 -> 2700 is a 20-minute hole with no captions at all: the boundary
  // stays on real caption starts rather than cutting a content-free block.
  assert.deepEqual(
    segments.map((s) => [s.startSeconds, s.endSeconds]),
    [
      [0, 300],
      [300, 900],
      [900, 1500],
      [1500, 2700],
      [2700, 3900],
    ],
  );
});

test("chapters merge while they fit and keep the first chapter title", () => {
  const segments = study.splitIntoSegments({
    chapters: [
      { title: "Intro", startSeconds: 0 },
      { title: "Why agents", startSeconds: 300 },
      { title: "Deep dive", startSeconds: 1500 },
    ],
    transcriptSegments: sparse,
    maxSeconds: 1500,
  });

  assert.deepEqual(
    segments.map((s) => [s.index, s.title, s.startSeconds, s.endSeconds]),
    [
      [1, "Intro", 0, 1500],
      [2, "Deep dive", 1500, 3900],
    ],
  );
});

test("a leading gap before the first chapter is covered", () => {
  const segments = study.splitIntoSegments({
    chapters: [{ title: "Main", startSeconds: 240 }],
    transcriptSegments: sparse,
    maxSeconds: 1200,
  });

  assert.equal(segments[0].title, "Segment 1 · 0:00–4:00");
  assert.equal(segments[0].startSeconds, 0);
  assert.equal(segments[1].title, "Main");
  assert.equal(segments.length, 2);
});

test("a single chapter longer than the cap stays alone instead of splitting", () => {
  const segments = study.splitIntoSegments({
    chapters: [
      { title: "Long", startSeconds: 0 },
      { title: "Short", startSeconds: 3000 },
    ],
    transcriptSegments: sparse,
    maxSeconds: 1200,
  });

  assert.deepEqual(
    segments.map((s) => [s.title, s.startSeconds, s.endSeconds]),
    [
      ["Long", 0, 3000],
      ["Short", 3000, 3900],
    ],
  );
});

test("unsorted, duplicate and malformed input cannot produce overlaps", () => {
  const segments = study.splitIntoSegments({
    chapters: [
      { title: "Second", startSeconds: 600 },
      { title: "First", startSeconds: 0 },
      { title: "Twin", startSeconds: 600 },
      { title: "", startSeconds: 900 },
      { title: "Broken", startSeconds: "soon" },
    ],
    transcriptSegments: [
      { start: 300, text: "b" },
      { start: "not-a-time", text: "drop" },
      { start: 0, text: "a" },
    ],
    maxSeconds: 2000,
  });

  assert.equal(segments[0].title, "First");
  assert.equal(segments[0].startSeconds, 0);
  assert.equal(segments[segments.length - 1].endSeconds, 900);
  segments.forEach((segment, index) => {
    assert.ok(segment.endSeconds > segment.startSeconds);
    if (index > 0) {
      assert.equal(segment.startSeconds, segments[index - 1].endSeconds);
    }
  });
});

test("empty input yields no segments", () => {
  assert.deepEqual(study.splitIntoSegments({}), []);
  assert.deepEqual(
    study.splitIntoSegments({ chapters: [], transcriptSegments: [] }),
    [],
  );
  assert.deepEqual(
    study.splitIntoSegments({ transcriptSegments: [{ text: "x" }] }),
    [],
  );
});

test("formatClock adds hours only when needed", () => {
  assert.equal(study.formatClock(0), "0:00");
  assert.equal(study.formatClock(1450), "24:10");
  assert.equal(study.formatClock(3723), "1:02:03");
  assert.equal(study.formatClock(-10), "0:00");
});

test("activeSegmentIndex finds the containing segment, else -1", () => {
  const segments = study.splitIntoSegments({
    chapters: [],
    transcriptSegments: dense,
    maxSeconds: 600,
  });
  assert.equal(study.activeSegmentIndex(segments, 0), 1);
  assert.equal(study.activeSegmentIndex(segments, 599), 1);
  assert.equal(study.activeSegmentIndex(segments, 600), 2);
  assert.equal(study.activeSegmentIndex(segments, 1799), 3);
  assert.equal(study.activeSegmentIndex(segments, 99999), -1);
  assert.equal(study.activeSegmentIndex(segments, null), -1);
});

test("segmentTextForRange joins the captions inside a range", () => {
  assert.equal(
    study.segmentTextForRange(dense, 0, 60),
    "line 0 line 1",
  );
  assert.equal(
    study.segmentTextForRange(dense, 0, null),
    dense.map((entry) => entry.text).join(" "),
  );
  assert.equal(study.segmentTextForRange([], 0, 10), "");
});

test("normalizeDictationText lowercases, drops punctuation, keeps apostrophes", () => {
  assert.equal(
    study.normalizeDictationText("  Don't   STOP,  2024!  "),
    "don't stop 2024",
  );
  assert.equal(study.normalizeDictationText("well-known"), "well known");
  assert.equal(study.normalizeDictationText("don\u2019t"), "don't");
  assert.equal(
    study.normalizeDictationText("Hello. \u4f60\u597d\uff01"),
    "hello \u4f60\u597d",
  );
  assert.equal(study.normalizeDictationText(null), "");
});

test("diffWords marks a perfect answer as fully accurate", () => {
  const result = study.diffWords(
    "Agents can plan and act.",
    "agents can plan and act",
  );
  assert.equal(result.accuracyPercent, 100);
  assert.equal(result.accuracy, 1);
  assert.equal(result.correct, 5);
  assert.equal(result.mistakeCount, 0);
  assert.equal(result.extraCount, 0);
  assert.deepEqual(
    result.tokens.map((t) => t.type),
    ["equal", "equal", "equal", "equal", "equal"],
  );
});

test("diffWords separates missing, wrong and extra words", () => {
  const result = study.diffWords(
    "They plan and then act.",
    "they plan but act now",
  );
  const byType = (type) => result.tokens.filter((t) => t.type === type);

  assert.equal(result.total, 5);
  assert.equal(result.correct, 3); // they / plan / act
  assert.equal(byType("missing").length, 1);
  assert.equal(byType("missing")[0].expected, "then");
  assert.equal(byType("wrong").length, 1);
  assert.deepEqual(byType("wrong")[0], {
    type: "wrong",
    expected: "and",
    actual: "but",
  });
  assert.equal(byType("extra").length, 1);
  assert.equal(byType("extra")[0].actual, "now");
  assert.equal(result.mistakeCount, 2);
  assert.equal(result.accuracyPercent, 60);
});

test("diffWords pairs a mismatch inside one hunk as a wrong word", () => {
  const result = study.diffWords("one two three", "one too three");
  assert.deepEqual(
    result.tokens.map((t) => t.type),
    ["equal", "wrong", "equal"],
  );
  assert.deepEqual(result.tokens[1], {
    type: "wrong",
    expected: "two",
    actual: "too",
  });
  assert.equal(result.accuracyPercent, 67);
  assert.equal(result.mistakeCount, 1);
});

test("diffWords lists paired words before the leftovers of the same hunk", () => {
  const result = study.diffWords("one two three four", "one tee four");
  assert.deepEqual(
    result.tokens.map((t) => [t.type, t.expected || t.actual]),
    [
      ["equal", "one"],
      ["wrong", "two"],
      ["missing", "three"],
      ["equal", "four"],
    ],
  );
  assert.equal(result.accuracyPercent, 50);
  assert.equal(result.mistakeCount, 2);
});

test("diffWords never matches a contraction to its expanded form", () => {
  const result = study.diffWords("I don't know.", "i do not know");
  const wrong = result.tokens.filter((t) => t.type === "wrong");
  const missing = result.tokens.filter((t) => t.type === "missing");

  assert.equal(missing.length, 0, "do not counts as wrong, never as missing");
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0].expected, "don't");
  assert.equal(result.extraCount, 1);
  assert.equal(result.accuracyPercent, 67);
});

test("diffWords handles empty sides and repeated words", () => {
  const empty = study.diffWords("", "");
  assert.equal(empty.accuracyPercent, 0);
  assert.equal(empty.total, 0);

  const nothingTyped = study.diffWords("try again", "");
  assert.equal(nothingTyped.missingCount, 2);
  assert.equal(nothingTyped.accuracyPercent, 0);

  const nothingExpected = study.diffWords("", "try again");
  assert.equal(nothingExpected.extraCount, 2);
  assert.equal(nothingExpected.accuracyPercent, 0);

  const repeated = study.diffWords("the cat and the hat", "the cat and the hat");
  assert.equal(repeated.accuracyPercent, 100);
  assert.equal(repeated.correct, 5);
});

test("formatRate renders every gear with the multiplication sign", () => {
  assert.deepEqual(
    study.PLAYBACK_RATES.map((rate) => study.formatRate(rate)),
    ["0.5×", "0.6×", "0.75×", "0.9×", "1×", "1.25×", "1.5×", "2×"],
  );
  assert.equal(study.formatRate(1), "1×");
  assert.equal(study.formatRate(0.75), "0.75×");
  assert.equal(study.formatRate("0.6"), "0.6×");
});

test("formatRate clamps out-of-range and unusable values", () => {
  assert.equal(study.formatRate(5), "2×");
  assert.equal(study.formatRate(0.1), "0.5×");
  assert.equal(study.formatRate(undefined), "1×");
  assert.equal(study.formatRate(null), "1×");
  assert.equal(study.formatRate(""), "1×");
  assert.equal(study.formatRate(Number.NaN), "1×");
  assert.equal(study.formatRate(Number.POSITIVE_INFINITY), "1×");
  assert.equal(study.formatRate(true), "1×");
});

test("clampPlaybackRate keeps the video element inside the supported range", () => {
  assert.equal(study.clampPlaybackRate(0.5), 0.5);
  assert.equal(study.clampPlaybackRate(2), 2);
  assert.equal(study.clampPlaybackRate(3), 2);
  assert.equal(study.clampPlaybackRate(0), 0.5);
  assert.equal(study.clampPlaybackRate(1), 1);
});

test("nextRate steps exactly one gear and stops at both ends", () => {
  assert.equal(study.nextRate(1, 1), 1.25);
  assert.equal(study.nextRate(1, -1), 0.9);
  assert.equal(study.nextRate(0.75, 1), 0.9);
  assert.equal(study.nextRate(1.5, -1), 1.25);
  // No wrap by default: the shortcut must never jump from slowest to fastest.
  assert.equal(study.nextRate(0.5, -1), 0.5);
  assert.equal(study.nextRate(2, 1), 2);
  // An omitted direction means "faster".
  assert.equal(study.nextRate(0.9), 1);
});

test("nextRate wraps only when asked, which is what the toolbar click cycles", () => {
  assert.equal(study.nextRate(2, 1, { wrap: true }), 0.5);
  assert.equal(study.nextRate(0.5, -1, { wrap: true }), 2);
  assert.equal(study.nextRate(1, 1, { wrap: true }), 1.25);
});

test("nextRate snaps an off-gear speed to the nearest gear", () => {
  // YouTube's own menu can leave a speed the gears do not contain.
  assert.equal(study.nextRate(1.1, 1), 1.25);
  assert.equal(study.nextRate(0.8, 1), 0.9);
  assert.equal(study.nextRate(0.8, -1), 0.6);
  // A midpoint between two gears snaps to the slower one first, so stepping
  // down from 0.825 lands one gear below it (0.6) and stepping up lands on the
  // other side of the tie (0.9).
  assert.equal(study.nextRate(0.825, 1), 0.9);
  assert.equal(study.nextRate(0.825, -1), 0.6);
  assert.equal(study.nextRate(0.95, 1), 1);
  assert.equal(study.nextRate(0.95, -1), 0.75);
  // Unusable input behaves like normal speed.
  assert.equal(study.nextRate(undefined, -1), 0.9);
  assert.equal(study.nextRate(null, 1), 1.25);
  // Out-of-range input is clamped before snapping.
  assert.equal(study.nextRate(99, -1), 1.5);
  assert.equal(study.nextRate(0, 1), 0.6);
});
