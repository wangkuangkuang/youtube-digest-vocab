const test = require("node:test");
const assert = require("node:assert/strict");
const vocab = require("../vocab.js");

const NOW = Date.parse("2025-03-01T08:00:00.000Z");
const DAY_MS = 86_400_000;

function entry(overrides) {
  return Object.assign(
    {
      id: "e1",
      text: "agent",
      language: "en",
      meaning: "代理",
      contextEn: "The agent plans.",
      contextZh: "代理会规划。",
      videoId: "vid1",
      videoTitle: "Title",
      timestampSeconds: 12,
      mastery: "new",
      createdAt: NOW,
    },
    overrides || {},
  );
}

test("normalizeVocabEntry backfills SRS defaults for legacy entries", () => {
  const normalized = vocab.normalizeVocabEntry(entry());
  assert.equal(normalized.interval, 0);
  assert.equal(normalized.ease, 2.5);
  assert.equal(normalized.reviewCount, 0);
  assert.equal(normalized.lapses, 0);
  assert.equal(normalized.lastReviewedAt, "");
  assert.equal(Number.isFinite(Date.parse(normalized.due)), true);
  // A legacy entry without SRS fields reads as due now; a freshly normalized
  // one is due at its own scheduled moment.
  assert.equal(vocab.isDue(entry(), NOW), true);
  assert.equal(vocab.isDue(normalized, Date.parse(normalized.due)), true);
  assert.equal(vocab.isDue(normalized, Date.parse(normalized.due) - 1), false);
});

test("normalizeVocabEntry clamps out-of-range SRS values", () => {
  const normalized = vocab.normalizeVocabEntry(
    entry({ interval: -5, ease: 9, reviewCount: "x", lapses: -1, due: "  " }),
  );
  assert.equal(normalized.interval, 0);
  assert.equal(normalized.ease, vocab.SRS_EASE_MAX);
  assert.equal(normalized.reviewCount, 0);
  assert.equal(normalized.lapses, 0);
  assert.equal(Number.isFinite(Date.parse(normalized.due)), true);
});

test("good grows the interval geometrically and schedules the due date", () => {
  let current = entry({ interval: 0, ease: 2.5, due: new Date(NOW).toISOString() });
  const steps = [];
  for (let i = 0; i < 4; i += 1) {
    current = vocab.applySrsGrade(current, "good", NOW);
    steps.push(current.interval);
  }
  assert.deepEqual(steps, [1, 3, 8, 20]);
  assert.equal(current.reviewCount, 4);
  assert.equal(current.mastery, "known");
  assert.equal(current.ease, 2.5);
  assert.equal(current.lastReviewedAt, new Date(NOW).toISOString());
  assert.equal(
    Date.parse(current.due),
    NOW + current.interval * DAY_MS,
  );
});

test("good uses the ease factor and never returns an interval below 1", () => {
  const once = vocab.applySrsGrade(
    entry({ interval: 0, ease: vocab.SRS_EASE_MIN }),
    "good",
    NOW,
  );
  assert.equal(once.interval, 1);

  const grown = vocab.applySrsGrade(entry({ interval: 10, ease: 1.3 }), "good", NOW);
  assert.equal(grown.interval, 13); // round(10 * 1.3)
});

test("hard keeps a minimum of one day and grows slowly", () => {
  const first = vocab.applySrsGrade(entry({ interval: 0 }), "hard", NOW);
  assert.equal(first.interval, 1);
  assert.equal(first.mastery, "fuzzy");

  const later = vocab.applySrsGrade(entry({ interval: 10 }), "hard", NOW);
  assert.equal(later.interval, 12); // round(10 * 1.2)
  assert.equal(later.ease, 2.5, "hard must not touch ease");
});

test("again resets to same-day review, lowers ease and counts a lapse", () => {
  const result = vocab.applySrsGrade(
    entry({ interval: 30, ease: 2.5, lapses: 2, mastery: "known" }),
    "again",
    NOW,
  );
  assert.equal(result.interval, 0);
  assert.equal(result.mastery, "new");
  assert.equal(result.lapses, 3);
  assert.equal(result.ease, 2.3);
  assert.equal(result.reviewCount, 1);
  assert.equal(Date.parse(result.due), NOW);
  assert.equal(vocab.isDue(result, NOW), true);
});

test("ease is clamped to [1.3, 2.8] across repeated failures", () => {
  let current = entry({ ease: 2.5 });
  for (let i = 0; i < 10; i += 1) {
    current = vocab.applySrsGrade(current, "again", NOW);
  }
  assert.equal(current.ease, vocab.SRS_EASE_MIN);
  assert.equal(vocab.SRS_EASE_MIN, 1.3);
  assert.equal(vocab.SRS_EASE_MAX, 2.8);
});

test("applySrsGrade never mutates its input and ignores unknown grades", () => {
  const original = entry({ interval: 4 });
  const graded = vocab.applySrsGrade(original, "good", NOW);
  assert.equal(original.interval, 4);
  assert.equal(original.reviewCount, undefined, "input is left alone");
  assert.equal(original.due, undefined);
  assert.notEqual(graded, original);

  const untouched = vocab.applySrsGrade(original, "banana", NOW);
  assert.equal(untouched.reviewCount, 0);
  assert.equal(untouched.interval, 4);
  assert.equal(untouched.mastery, "new");
});

test("isDue treats a missing or unparsable due as due now", () => {
  assert.equal(vocab.isDue(entry(), NOW), true);
  assert.equal(vocab.isDue(entry({ due: "not-a-date" }), NOW), true);
  assert.equal(vocab.isDue(entry({ due: new Date(NOW + DAY_MS).toISOString() }), NOW), false);
  assert.equal(vocab.isDue(entry({ due: new Date(NOW).toISOString() }), NOW), true);
  // ISO strings are accepted in place of a timestamp
  assert.equal(vocab.isDue(entry({ due: new Date(NOW).toISOString() }), new Date(NOW)), true);
});

test("dueEntries filters and orders by due date ascending", () => {
  const entries = [
    entry({ id: "later", due: new Date(NOW + 3 * DAY_MS).toISOString() }),
    entry({ id: "unscheduled" }),
    entry({ id: "overdue", due: new Date(NOW - 2 * DAY_MS).toISOString() }),
    entry({ id: "today", due: new Date(NOW).toISOString() }),
  ];

  assert.deepEqual(
    vocab.dueEntries(entries, NOW).map((e) => e.id),
    ["unscheduled", "overdue", "today"],
  );
  assert.deepEqual(vocab.dueEntries([], NOW), []);
});

test("applyVocabUpdate is the transport for review grades", () => {
  const entries = [entry({ interval: 1 })];
  const graded = vocab.applySrsGrade(entries[0], "good", NOW);
  const outcome = vocab.applyVocabUpdate(entries, "e1", {
    due: graded.due,
    interval: graded.interval,
    ease: graded.ease,
    reviewCount: graded.reviewCount,
    lapses: graded.lapses,
    lastReviewedAt: graded.lastReviewedAt,
    mastery: graded.mastery,
  });

  assert.equal(outcome.updated, true);
  const stored = outcome.entries[0];
  assert.equal(stored.interval, 3);
  assert.equal(stored.ease, 2.5);
  assert.equal(stored.reviewCount, 1);
  assert.equal(stored.mastery, "known");
  assert.equal(stored.due, graded.due);
  assert.equal(vocab.isDue(stored, NOW), false);

  const junk = vocab.applyVocabUpdate(entries, "e1", {
    due: "   ",
    interval: "nope",
    ease: "nope",
    reviewCount: "nope",
    lapses: "nope",
  }).entries[0];
  assert.equal(junk.interval, 1, "invalid numbers fall back to the stored value");
  assert.equal(junk.ease, 2.5);
  assert.equal(typeof junk.due, "undefined");
});

test("toAnkiTsv appends the due date as the third column", () => {
  const due = new Date(NOW + DAY_MS).toISOString();
  const tsv = vocab.toAnkiTsv([entry({ due, createdAt: 1700000000000 })]);
  const fields = tsv.split("\t");
  assert.equal(fields.length, 3);
  assert.equal(fields[2], due);

  const legacy = vocab.toAnkiTsv([entry({ createdAt: 1700000000000 })]);
  assert.equal(legacy.split("\t")[2], "");
});
