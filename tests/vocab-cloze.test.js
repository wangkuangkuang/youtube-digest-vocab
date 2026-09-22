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
