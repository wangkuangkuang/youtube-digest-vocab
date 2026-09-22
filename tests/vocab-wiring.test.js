const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const bg = fs.readFileSync(path.resolve(__dirname, "..", "background.js"), "utf8");
const panel = fs.readFileSync(path.resolve(__dirname, "..", "sidepanel.js"), "utf8");
const html = fs.readFileSync(path.resolve(__dirname, "..", "sidepanel.html"), "utf8");

test("background loads the vocab module via importScripts", () => {
  assert.match(bg, /importScripts\("vocab\.js"\);/);
});

test("dispatcher routes all four vocab storage actions", () => {
  ["saveVocabEntry", "getVocabEntries", "updateVocabEntry", "deleteVocabEntry"].forEach(
    (action) => assert.match(bg, new RegExp('message\\.action === "' + action + '"')),
  );
});

test("storage handlers use ytd_vocab key and YTD_VOCAB helpers", () => {
  const handlers = bg.match(/async function handle(Save|Get|Update|Delete)Vocab\w*\(/g) || [];
  assert.equal(handlers.length >= 4, true);
  assert.match(bg, /YTD_VOCAB\.applyVocabSave/);
  assert.match(bg, /YTD_VOCAB\.applyVocabUpdate/);
  assert.match(bg, /YTD_VOCAB\.applyVocabDelete/);
  assert.match(bg, /chrome\.storage\.local\.set\(\{ ytd_vocab: /);
});

test("lookupVocabMeaning route exists with JSON-mode AI call", () => {
  assert.match(bg, /message\.action === "lookupVocabMeaning"/);
  assert.match(bg, /async function handleLookupVocabMeaning\(/);
  assert.match(bg, /loadPromptSection\(\s*"vocab-lookup\.md"/);
});

test("vocab-lookup prompt file follows the prompt conventions", () => {
  const prompt = fs.readFileSync(
    path.resolve(__dirname, "..", "prompts", "vocab-lookup.md"),
    "utf8",
  );
  assert.match(prompt, /## System prompt/);
  assert.match(prompt, /## User prompt/);
  assert.match(prompt, /\{selectedText\}/);
  assert.match(prompt, /\{transcriptContext\}/);
  assert.match(prompt, /\{videoTitle\}/);
});

test("sidepanel loads vocab.js and keeps the selection card contract", () => {
  assert.match(html, /<script src="vocab\.js"><\/script>/);
  assert.match(panel, /tooltip\.id = "explainTooltip"/);
  assert.match(panel, /class="explain-btn"/);
  assert.match(panel, /class="selection-note-btn"/);
});

test("selection card performs cached-or-AI meaning lookup with a generation guard", () => {
  assert.match(panel, /YTD_VOCAB\.resolveMeaningSource\(/);
  assert.match(panel, /action: "lookupVocabMeaning"/);
  assert.match(panel, /vocabLookupGeneration/);
  assert.match(panel, /transcriptParagraphCache\.get\(/); // ZH from cache, never the placeholder
});

test("selection card saves entries and clears cross-highlight on dismiss", () => {
  assert.match(panel, /action: "saveVocabEntry"/);
  assert.match(panel, /cross-highlight-target/);
  assert.match(panel, /function dismissSelectionActions\([\s\S]*?clearCrossHighlight\(\)/);
});
