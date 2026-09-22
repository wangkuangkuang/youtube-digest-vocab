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
