const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const bg = fs.readFileSync(path.resolve(__dirname, "..", "background.js"), "utf8");
const panel = fs.readFileSync(path.resolve(__dirname, "..", "sidepanel.js"), "utf8");
const html = fs.readFileSync(path.resolve(__dirname, "..", "sidepanel.html"), "utf8");
const css = fs.readFileSync(path.resolve(__dirname, "..", "sidepanel.css"), "utf8");
const explainPrompt = fs.readFileSync(path.resolve(__dirname, "..", "prompts", "explain.md"), "utf8");

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

test("vocab tab markup and tab button exist", () => {
  assert.match(html, /data-tab="vocab"/);
  assert.match(html, /data-panel="vocab"/);
  assert.match(html, /id="vocabList"/);
  assert.match(html, /id="vocabQuiz"/);
});

test("vocab list renders mastery cycle, listen-back, delete", () => {
  assert.match(panel, /async function loadVocabEntries\(/);
  assert.match(panel, /function renderVocabList\(/);
  assert.match(panel, /action: "updateVocabEntry"/);
  assert.match(panel, /action: "deleteVocabEntry"/);
  assert.match(panel, /function playVocabEntry\(/);
  assert.match(panel, /switchTab\("transcript"\)/);
});

test("highlight engine walks text nodes but skips any mark, and never unwraps search marks", () => {
  assert.match(panel, /function applyVocabHighlights\(/);
  assert.match(panel, /closest\("mark"\)/);
  assert.match(panel, /mark\.vocab-highlight/);
  const clearFn = panel.match(/function clearVocabHighlights\([\s\S]*?\n\}/)?.[0] || "";
  assert.equal(clearFn.includes("transcript-search-highlight"), false);
});

test("render pipeline re-applies vocab highlights", () => {
  assert.match(panel, /refreshTranscriptSearch\(\{ preserveIndex: false, scroll: false \}\);\s*\n\s*refreshVocabHighlights\(\);/);
  assert.match(panel, /function updateTranslatedRow[\s\S]*?applyVocabHighlights\(row\);/);
});

test("export uses YTD_VOCAB serializers with blob download", () => {
  assert.match(panel, /YTD_VOCAB\.toCsv\(/);
  assert.match(panel, /YTD_VOCAB\.toAnkiTsv\(/);
  assert.match(panel, /URL\.createObjectURL\(/);
});

test("quiz mode grades into mastery updates", () => {
  assert.match(panel, /YTD_VOCAB\.generateClozeQuestions\(/);
  assert.match(panel, /function startVocabQuiz\(/);
  assert.match(panel, /显示答案/);
  assert.match(panel, /认识/);
});

test("selection card stacks vertically and shows the full term", () => {
  assert.match(css, /\.explain-tooltip\s*\{[\s\S]*?flex-direction:\s*column/);
  assert.doesNotMatch(panel, /text\.slice\(0, 60\)/); // no mid-term truncation
  assert.match(css, /\.selection-term\s*\{[\s\S]*?white-space:\s*normal/);
});

test("all four selection actions sit in one row after the meaning", () => {
  const actions = panel.match(/<div class="selection-actions">[\s\S]*?<\/div>/);
  assert.ok(actions, "selection-actions row exists");
  const row = actions[0];
  ["selection-speak-btn", "explain-btn", "selection-note-btn", "selection-save-btn"].forEach(
    (cls) => assert.ok(row.includes(cls), cls + " inside the actions row"),
  );
});

test("explain expands inline below the card with bilingual output, no modal", () => {
  assert.doesNotMatch(panel, /explainModal/);
  assert.match(panel, /selection-explain/);
  assert.match(panel, /中文/); // client-side split marker
  assert.match(explainPrompt, /中文/); // prompt asks for the Chinese line
});

test("selecting text inside the explanation opens a nested lookup", () => {
  assert.match(panel, /selection-explain-subbox/);
  assert.match(panel, /tooltip\.contains\(range\.startContainer\)/);
});

test("speak picks the best available voice per language", () => {
  assert.match(panel, /YTD_VOCAB\.pickBestVoice\(/);
});

test("selection card is clamped inside the panel viewport", () => {
  assert.match(panel, /const cardWidth = Math\.min\(340, window\.innerWidth - 20\);/);
  assert.match(panel, /Math\.min\(centerX, window\.innerWidth - cardWidth \/ 2 - 10\)/);
  assert.match(panel, /Math\.max\(cardWidth \/ 2 \+ 10, /);
});

test("term and meaning are separated by a divider line", () => {
  assert.match(css, /\.explain-tooltip \.selection-term\s*\{[\s\S]*?border-bottom: 1px solid/);
});

test("vocab entry delete icon renders as a visible stroke icon", () => {
  assert.match(css, /\.vocab-delete svg\s*\{[\s\S]*?stroke:\s*currentColor/);
  assert.match(css, /\.vocab-delete svg\s*\{[\s\S]*?fill:\s*none/);
});

test("original-mode transcript markup is highlighted and captured", () => {
  assert.match(panel, /\.querySelectorAll\("\.transcript-text, \.transcript-original, \.transcript-translation"\)/);
  assert.match(panel, /row\?\.querySelector\("\.transcript-original"\)\?\.textContent\?\.trim\(\)\s*\|\|\s*row\?\.querySelector\("\.transcript-text"\)/);
});

test("attribute contexts escape quotes via escapeHtmlAttr", () => {
  assert.match(panel, /function escapeHtmlAttr\([\s\S]*?&quot;[\s\S]*?\n\}/);
  assert.match(panel, /title="\$\{escapeHtmlAttr\(entry\.videoTitle\)\}"/);
});

test("failed vocab saves report failure instead of success", () => {
  const saveHandler = panel.match(/action: "saveVocabEntry"[\s\S]{0,1200}/)?.[0] || "";
  assert.match(saveHandler, /result\.status === "duplicate"[\s\S]*?else if \(result\?\.success\)/);
  assert.match(saveHandler, /保存失败/);
});

test("search highlight walker skips nodes inside any mark", () => {
  assert.match(panel, /closest\("button, mark"\)/);
});
