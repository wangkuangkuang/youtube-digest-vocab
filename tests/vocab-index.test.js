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
