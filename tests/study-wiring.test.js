const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const panel = read("sidepanel.js");
const html = read("sidepanel.html");
const css = read("sidepanel.css");

// The study region is the one contiguous block at the end of sidepanel.js.
const studyBlock = panel.slice(
  panel.indexOf("// STUDY WORKFLOW"),
  panel.indexOf("// Pure helpers are exposed for the repository's Node tests"),
);

// Ids that only exist after the panel creates them at runtime.
const DYNAMIC_IDS = new Set(["studyToast", "vocabReviewAgain", "vocabReviewExit"]);

test("the side panel loads study.js before sidepanel.js", () => {
  const studyTag = html.indexOf('<script src="study.js"></script>');
  const vocabTag = html.indexOf('<script src="vocab.js"></script>');
  const panelTag = html.indexOf('<script src="sidepanel.js"></script>');
  assert.ok(studyTag > -1, "study.js must be loaded");
  assert.ok(vocabTag < studyTag, "vocab.js stays ahead of study.js");
  assert.ok(studyTag < panelTag, "study.js must load before sidepanel.js");
});

test("every element id touched by the study workflow exists in the HTML", () => {
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const usedIds = [...studyBlock.matchAll(/getElementById\(\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(usedIds.length > 10, "study workflow should touch real elements");
  usedIds.forEach((id) => {
    if (DYNAMIC_IDS.has(id)) return;
    assert.ok(htmlIds.has(id), `sidepanel.html is missing id="${id}"`);
  });
});

test("the study panels ship collapsed and wired to their toggles", () => {
  [
    ["segmentsPanel", "segmentsToggleBtn"],
    ["dictationPanel", "dictationToggleBtn"],
    ["shortcutsPanel", "shortcutsToggleBtn"],
  ].forEach(([panelId, buttonId]) => {
    assert.match(
      html,
      new RegExp(`id="${panelId}"[^>]*\\shidden`),
      `${panelId} must start hidden`,
    );
    assert.match(
      html,
      new RegExp(`id="${buttonId}"[^>]*aria-expanded="false"`),
      `${buttonId} must advertise its collapsed state`,
    );
  });
  assert.match(panel, /toggleStudyPanel\("segmentsPanel", "segmentsToggleBtn"\)/);
  assert.match(panel, /toggleStudyPanel\("shortcutsPanel", "shortcutsToggleBtn"\)/);
});

test("study UI keeps no emoji or emoji-like pictographs", () => {
  assert.doesNotMatch(studyBlock, /\p{Extended_Pictographic}|[✓✕⧉▶]/u);
  const toolbar = html.slice(
    html.indexOf('id="studyToolbar"'),
    html.indexOf('id="transcriptList"'),
  );
  assert.doesNotMatch(toolbar, /\p{Extended_Pictographic}|[✓✕⧉▶]/u);
});

test("page-side calls stay inside the documented content-script contract", () => {
  const allowed = new Set([
    "relayToContent", // the envelope used by every page-side call
    "setCaptionsHidden",
    "setLoop",
    "setPlaybackRate",
    "getPlayerState",
    "playPause",
    "getChapters",
    "updateVocabEntry", // extension-internal, never relayed to the page
  ]);
  const actions = [...studyBlock.matchAll(/action:\s*"([a-zA-Z]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(actions.length > 6, "the workflow must actually call the player");
  [...new Set(actions)].forEach((action) => {
    assert.ok(allowed.has(action), `unexpected action: ${action}`);
  });
  [
    "setCaptionsHidden",
    "setLoop",
    "setPlaybackRate",
    "getPlayerState",
    "playPause",
    "getChapters",
  ].forEach((action) =>
    assert.ok(actions.includes(action), `missing ${action}`),
  );
});

test("a silent page degrades to a toast instead of throwing", () => {
  assert.match(studyBlock, /STUDY_RELAY_TIMEOUT_MS/);
  assert.match(studyBlock, /Promise\.race\(\[/);
  assert.match(studyBlock, /if \(!response \|\| response\.success === false\) return null;/);
  assert.match(studyBlock, /return response\.response \?\? null;/);
  assert.match(studyBlock, /showStudyToast\(LEGACY_PAGE_HINT, \{ variant: "error" \}\)/);
});

test("captions state is remembered under the documented storage key", () => {
  assert.match(studyBlock, /const CAPTIONS_HIDDEN_KEY = "ytd_captions_hidden";/);
  assert.match(studyBlock, /chrome\.storage\.local\.get\(CAPTIONS_HIDDEN_KEY\)/);
  assert.match(studyBlock, /chrome\.storage\.local\.set\(\{ \[CAPTIONS_HIDDEN_KEY\]: hidden \}\)/);
  assert.match(studyBlock, /button\.textContent = hidden \? "字幕：关" : "字幕：开";/);
  assert.match(studyBlock, /button\.setAttribute\("aria-pressed", String\(hidden\)\)/);
});

test("progress and dictation are stored per video and restored", () => {
  assert.match(studyBlock, /const STUDY_PROGRESS_PREFIX = "ytd_progress_";/);
  assert.match(studyBlock, /const STUDY_DICTATION_PREFIX = "ytd_dictation_";/);
  assert.match(studyBlock, /function studyProgressKey\(videoId\)[\s\S]*?STUDY_PROGRESS_PREFIX \+ videoId/);
  assert.match(studyBlock, /function dictationStorageKey\(videoId\)[\s\S]*?STUDY_DICTATION_PREFIX \+ videoId/);
  assert.match(studyBlock, /segments: studySegments\.map\([\s\S]*?activeIndex: studyActiveSegment,[\s\S]*?updatedAt: Date\.now\(\)/);
  assert.match(studyBlock, /function mergeSegmentProgress\(computed, saved\)/);
  // A new video must never inherit the previous one's loop or panels.
  assert.match(
    studyBlock,
    /function resetStudyForVideo\(\)[\s\S]*?action: "setLoop",\s*start: 0,\s*end: null,\s*mode: "loop",\s*enabled: false,/,
  );
  assert.match(panel, /videoChanged[\s\S]{0,400}resetStudyForVideo\(\);/);
});

test("sentence loop follows the clicked sentence and highlights one row", () => {
  assert.match(
    panel,
    /seekTo\(seconds\);\s*\n\s*\/\/ The sentence loop follows the user's click instead of looping the old line\.\s*\n\s*followLoopToSentence\(seconds\);/,
  );
  assert.match(
    studyBlock,
    /function followLoopToSentence\(seconds\)[\s\S]*?if \(!sentenceLoop\) return;[\s\S]*?void pushSentenceLoop\(range, "loop"\);/,
  );
  assert.match(studyBlock, /emit|pushSentenceLoop\(range, "once"\)/);
  assert.match(studyBlock, /refreshLoopHighlight\(\)/);
  assert.match(css, /\.transcript-entry\.sentence-looping\s*\{[^}]*outline: 1\.5px solid var\(--accent\);/);
  assert.match(css, /\.sentence-loop-btn\.active\s*\{[^}]*background: var\(--accent\);/);
  assert.match(panel, /attachSentenceControls\(div, group\.start, grouped\[index \+ 1\]\?\.start\);/);
  assert.match(panel, /attachSentenceControls\(div, segment\.start, segments\[index \+ 1\]\?\.start\);/);
  assert.match(studyBlock, /function attachSentenceControls\(row, seconds, nextSeconds\)/);
  assert.match(studyBlock, /replay\.addEventListener\("click"[\s\S]*?void replaySentence\(sentenceRange\(seconds, nextSeconds\)\)/);
  assert.match(studyBlock, /loop\.addEventListener\("click"[\s\S]*?void toggleSentenceLoop\(sentenceRange\(seconds, nextSeconds\)\)/);
});

test("the sentence cursor survives a lagging playback head", () => {
  // The playhead only refreshes every tracking tick, so R and L must not chase
  // .active-playback: that made repeated ArrowDown presses stick on one row.
  assert.match(studyBlock, /let sentenceFocusIndex = -1;/);
  assert.match(
    studyBlock,
    /function focusTranscriptRow\(row\)[\s\S]*?sentenceFocusIndex = rows\.indexOf\(row\);/,
  );
  assert.match(
    studyBlock,
    /function moveSentenceFocus\(delta\)[\s\S]*?let index = sentenceFocusIndex;/,
  );
  assert.match(
    studyBlock,
    /row\.addEventListener\("click", \(\) => \{\s*\n\s*sentenceFocusIndex = transcriptRows\(\)\.indexOf\(row\);/,
  );
  assert.match(studyBlock, /sentenceFocusIndex = -1;\n  dictationRecords = \{\};/);
  // Number(null) === 0, so the loose form pinned both R and L to sentence 1.
  assert.match(
    studyBlock,
    /function currentSentenceRange\(seconds, options\)[\s\S]*?typeof seconds === "number" &&\s*\n\s*Number\.isFinite\(seconds\) &&\s*\n\s*seconds >= 0/,
  );
  assert.doesNotMatch(studyBlock, /Number\.isFinite\(Number\(seconds\)\)/);
  assert.match(
    studyBlock,
    /index === -1 &&\s*\n\s*preferCursor &&\s*\n\s*sentenceFocusIndex >= 0 &&\s*\n\s*sentenceFocusIndex < rows\.length/,
  );
  // Dictation mirrors the video instead of the reading cursor, so a cursor left
  // behind by an earlier click cannot freeze the reference text.
  assert.match(
    studyBlock,
    /function currentDictationTarget\(\)[\s\S]*?const activeRow = document\.querySelector\(\s*\n\s*"#transcriptList \.transcript-entry\.active-playback",\s*\n\s*\);[\s\S]*?Number\.isFinite\(playbackSeconds\) \? playbackSeconds : null/,
  );
});

test("the keyboard handler ignores text boxes and claims its own keys", () => {
  assert.match(
    studyBlock,
    /function isEditableTarget\(target\)[\s\S]*?tag === "INPUT" \|\| tag === "TEXTAREA" \|\| tag === "SELECT" \|\| Boolean\(target\.isContentEditable\)/,
  );
  assert.match(
    studyBlock,
    /if \(isEditableTarget\(event\.target\)\) \{\s*\n\s*if \(event\.key === "Escape"\) event\.target\.blur\(\);\s*\n\s*return;/,
  );
  assert.match(studyBlock, /if \(event\.metaKey \|\| event\.ctrlKey \|\| event\.altKey\) return;/);
  ['case " ":', 'case "Spacebar":', 'case "ArrowUp":', 'case "ArrowDown":', 'case "r":', 'case "R":', 'case "l":', 'case "L":', 'case "c":', 'case "C":', 'case "d":', 'case "D":'].forEach(
    (key) => assert.ok(studyBlock.includes(key), `${key} must be handled`),
  );
  assert.equal(
    (studyBlock.match(/event\.preventDefault\(\);/g) || []).length >= 7,
    true,
    "handled keys must preventDefault",
  );
  assert.match(studyBlock, /document\.addEventListener\("keydown", handleStudyShortcut\);/);
  assert.match(studyBlock, /moveSentenceFocus\(-1\)/);
  assert.match(studyBlock, /moveSentenceFocus\(1\)/);
  assert.match(
    studyBlock,
    /function focusTranscriptRow\(row\)[\s\S]*?row\.scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/,
  );
  assert.match(
    studyBlock,
    /function moveSentenceFocus\(delta\)[\s\S]*?focusTranscriptRow\(row\);/,
  );
  // Cmd/Ctrl + Enter grades from inside the box, where the global handler is off.
  assert.match(
    panel,
    /getElementById\("dictationInput"\)\?\.addEventListener\("keydown", \(event\) => \{\s*\n\s*if \(\(event\.metaKey \|\| event\.ctrlKey\) && event\.key === "Enter"\) \{\s*\n\s*event\.preventDefault\(\);\s*\n\s*checkDictation\(\);/,
  );
});

test("the shortcut reference documents every bound key", () => {
  const shortcuts = html.slice(
    html.indexOf('id="shortcutsPanel"'),
    html.indexOf('<div id="transcriptList">'),
  );
  ["Space", "↑ / ↓", ">R<", ">L<", ">C<", ">D<", "Esc", "Cmd / Ctrl + Enter", "[ / ]"].forEach(
    (needle) => assert.ok(shortcuts.includes(needle), `shortcuts panel misses ${needle}`),
  );
});

test("the speed control steps through the gears shared with study.js", () => {
  // The gear arithmetic is pure and lives in study.js, so the panel only
  // renders it and mirrors the value the page reports back.
  assert.match(studyBlock, /let playbackRate = 1;/);
  assert.match(html, /id="playbackRateBtn"[\s\S]*?>\s*速度 1×\s*<\/button>/);
  assert.match(studyBlock, /button\.textContent = `速度 \$\{YTD_STUDY\.formatRate\(rate\)\}`;/);
  assert.match(
    studyBlock,
    /getElementById\("playbackRateBtn"\)\?\.addEventListener\("click"[\s\S]*?void cyclePlaybackRate\(\);/,
  );
  assert.match(studyBlock, /case "\[":\s*\n\s*event\.preventDefault\(\);\s*\n\s*void stepPlaybackRate\(-1\);/);
  assert.match(studyBlock, /case "\]":\s*\n\s*event\.preventDefault\(\);\s*\n\s*void stepPlaybackRate\(1\);/);
  // `[`/`]` stop at the ends; only the toolbar click wraps around.
  assert.match(studyBlock, /YTD_STUDY\.nextRate\(playbackRate, direction\)/);
  assert.match(studyBlock, /YTD_STUDY\.nextRate\(playbackRate, 1, \{ wrap: true \}\)/);
  // A silent page must not leave a speed on the button that is not playing.
  assert.match(
    studyBlock,
    /function applyPlaybackRate\(rate, \{ announce = true \} = \{\}\)[\s\S]*?action: "setPlaybackRate", rate[\s\S]*?if \(!response \|\| !Number\.isFinite\(Number\(response\.rate\)\)\)[\s\S]*?showStudyToast\(LEGACY_PAGE_HINT, \{ variant: "error" \}\)[\s\S]*?return playbackRate;/,
  );
  assert.match(
    studyBlock,
    /playbackRate = Number\(response\.rate\);[\s\S]*?showStudyToast\(`速度 \$\{YTD_STUDY\.formatRate\(playbackRate\)\}`/,
  );
  // The panel adopts the live speed when it opens and when the video changes.
  assert.match(
    studyBlock,
    /function syncPlaybackRate\(\)[\s\S]*?action: "getPlayerState"[\s\S]*?if \(!Number\.isFinite\(rate\) \|\| rate <= 0\) return playbackRate;/,
  );
  assert.match(studyBlock, /function initStudyUi\(\)[\s\S]*?void syncPlaybackRate\(\);/);
  assert.match(studyBlock, /void pruneStudyStorage\(\);/);
  assert.match(
    studyBlock,
    /action: "setLoop",\s*start: 0,\s*end: null,\s*mode: "loop",\s*enabled: false,\s*\}\);\s*\n\s*\/\/ The new player starts at 1x[\s\S]*?void syncPlaybackRate\(\);/,
  );
});

test("dictation grades with study.js and saves per segment", () => {
  assert.match(studyBlock, /YTD_STUDY\.diffWords\(target\.text, input\.value\)/);
  assert.match(studyBlock, /YTD_STUDY\.splitIntoSegments\(\{/);
  assert.match(studyBlock, /YTD_STUDY\.activeSegmentIndex\(/);
  assert.match(studyBlock, /YTD_STUDY\.segmentTextForRange\(/);
  assert.match(studyBlock, /YTD_STUDY\.formatClock\(/);
  assert.match(
    studyBlock,
    /dictationRecords\[target\.index\] = \{\s*text: input\.value,\s*accuracy: diff\.accuracyPercent,\s*updatedAt: Date\.now\(\),/,
  );
  assert.match(studyBlock, /span\.className = `dictation-token token-\$\{token\.type\}`;/);
  assert.match(css, /\.dictation-token\.token-missing\s*\{[^}]*text-decoration: line-through;/);
  assert.match(css, /\.dictation-token\.token-extra\s*\{[^}]*text-decoration: line-through;/);
  assert.match(css, /\.dictation-token\.token-wrong\s*\{/);
  assert.match(css, /\.dictation-actual\s*\{/);
  // Typing must not be clobbered by the playback-driven target refresh.
  assert.match(
    studyBlock,
    /function maybeRefreshDictationTarget\(\)[\s\S]*?if \(!editableInputIsPristine\(input\)\) return;/,
  );
});

test("vocab review grades through vocab.js and persists every SRS field", () => {
  assert.match(studyBlock, /YTD_VOCAB\.dueEntries\(currentVocabEntries, Date\.now\(\)\)/);
  assert.match(studyBlock, /YTD_VOCAB\.applySrsGrade\(entry, grade, Date\.now\(\)\)/);
  [
    "mastery: graded.mastery",
    "due: graded.due",
    "interval: graded.interval",
    "ease: graded.ease",
    "reviewCount: graded.reviewCount",
    "lapses: graded.lapses",
    "lastReviewedAt: graded.lastReviewedAt",
  ].forEach((field) => {
    assert.ok(studyBlock.includes(field), `the grade patch must carry ${field}`);
  });
  assert.match(studyBlock, /data-srs-grade="again">忘记/);
  assert.match(studyBlock, /data-srs-grade="hard">模糊/);
  assert.match(studyBlock, /data-srs-grade="good">认识/);
  assert.match(html, /id="vocabReviewBtn"[\s\S]*?今日到期 <span id="vocabDueCount">0<\/span>/);
  assert.match(panel, /function renderVocabList\(\)[\s\S]{0,600}refreshVocabDueCount\(\);/);
});

test("sidepanel.js evaluates with study.js and vocab.js already loaded", () => {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({ set textContent(v) {}, get innerHTML() { return ""; } }),
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage: () => Promise.resolve({}) },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("vocab.js"), sandbox);
  vm.runInNewContext(read("study.js"), sandbox);
  assert.equal(typeof sandbox.YTD_STUDY.diffWords, "function");
  vm.runInNewContext(panel, sandbox);
  assert.equal(typeof sandbox.__YTD_TRANSCRIPT_TESTING__, "object");
  assert.equal(
    sandbox.__YTD_TRANSCRIPT_TESTING__.handleStudyShortcut,
    undefined,
    "the study wiring is not advertised as a pure helper",
  );
});
