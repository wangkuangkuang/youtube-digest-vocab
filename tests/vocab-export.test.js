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
  assert.equal(lines[1], '"run, ""fast""",en,"/rʌn/ v. 跑 ; 运转","He likes to run, fast",他喜欢快跑,"A, Title",https://youtu.be/dQw4w9WgXcQ?t=12,12.9,new,2023-11-14T22:13:20.000Z');
});

test("toAnkiTsv strips tabs/newlines and bolds the term", () => {
  const tsv = vocab.toAnkiTsv([entry]);
  const [front, back] = tsv.split("\t");
  assert.equal(front, 'run, "fast"<br>He likes to <b>run, fast</b>');
  assert.match(back, /^\/rʌn\/ v\. 跑 ; 运转<br>source: A, Title$/);
  assert.equal(tsv.includes("\n"), false);
});
