const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const contentScript = fs.readFileSync(
  path.resolve(__dirname, "..", "content.js"),
  "utf8",
);

const STORAGE_KEY = "ytd_playback_rate";

/** The video element is the only part of the page this feature touches. */
function createVideo({ playbackRate = 1, duration = 300 } = {}) {
  return {
    playbackRate,
    duration,
    currentTime: 0,
    paused: false,
    play: () => Promise.resolve(),
    pause() {
      this.paused = true;
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

/**
 * Boots content.js in a context just small enough for its load-time work, and
 * keeps the pieces the playback-rate contract is made of: the video element,
 * chrome.storage.local, and the captured document listeners.
 */
function createHarness({ stored = {}, video = createVideo() } = {}) {
  const documentListeners = {};
  const storage = { ...stored };
  const handlers = {};

  const context = {
    console,
    document: {
      readyState: "complete",
      head: { appendChild() {} },
      documentElement: { appendChild() {} },
      body: { appendChild() {}, removeChild() {}, children: [] },
      addEventListener(type, listener, capture) {
        (documentListeners[type] ||= []).push({ listener, capture });
      },
      querySelector(selector) {
        return selector === "video.html5-main-video" ? video : null;
      },
      querySelectorAll() {
        return [];
      },
      getElementById() {
        return null;
      },
      createElement() {
        return {
          style: {},
          textContent: "",
          innerHTML: "",
          setAttribute() {},
          appendChild() {},
          remove() {},
        };
      },
    },
    window: {
      location: { pathname: "/watch", href: "https://www.youtube.com/watch?v=abc" },
      innerWidth: 1200,
      addEventListener() {},
      getComputedStyle: () => ({ display: "flex", visibility: "visible" }),
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            handlers.onMessage = listener;
          },
        },
        sendMessage: async () => ({ success: true }),
      },
      storage: {
        local: {
          async get(key) {
            return { [key]: storage[key] };
          },
          async set(patch) {
            Object.assign(storage, patch);
          },
        },
      },
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
  };

  vm.createContext(context);
  vm.runInContext(contentScript, context);

  return {
    context,
    storage,
    video,
    documentListeners,
    /** Sends a message through the real listener and returns the response. */
    send(payload) {
      let response;
      handlers.onMessage(payload, null, (value) => {
        response = value;
      });
      return response;
    },
    fire(type) {
      (documentListeners[type] || []).forEach(({ listener }) => listener());
    },
    /** Lets the restore promise chain settle. */
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test("setPlaybackRate clamps, applies to the video and remembers the choice", () => {
  const harness = createHarness();

  // Spread into a plain object: the response was created in the vm realm.
  assert.deepEqual({ ...harness.send({ action: "setPlaybackRate", rate: 0.75 }) }, {
    success: true,
    rate: 0.75,
  });
  assert.equal(harness.video.playbackRate, 0.75);
  assert.equal(harness.storage[STORAGE_KEY], 0.75);

  // Both ends of the supported range, plus a string from a stale panel build.
  assert.equal(harness.send({ action: "setPlaybackRate", rate: 5 }).rate, 2);
  assert.equal(harness.video.playbackRate, 2);
  assert.equal(harness.send({ action: "setPlaybackRate", rate: 0.2 }).rate, 0.5);
  assert.equal(harness.send({ action: "setPlaybackRate", rate: "1.25" }).rate, 1.25);

  // Unusable input means normal speed instead of NaN on the element.
  [undefined, null, "", true, Number.NaN, {}].forEach((rate) => {
    assert.equal(harness.send({ action: "setPlaybackRate", rate }).rate, 1);
    assert.equal(harness.video.playbackRate, 1);
  });
  assert.equal(harness.storage[STORAGE_KEY], 1);
});

test("getPlayerState reports the live rate and falls back before the player exists", () => {
  const harness = createHarness();
  harness.video.playbackRate = 1.5;
  assert.equal(harness.send({ action: "getPlayerState" }).playbackRate, 1.5);

  // A fresh page has no video element yet; the claimed speed is still answered.
  const early = createHarness({ video: null });
  assert.equal(early.send({ action: "getPlayerState" }).playbackRate, 1);
  assert.equal(early.send({ action: "setPlaybackRate", rate: 0.9 }).rate, 0.9);
  assert.equal(early.send({ action: "getPlayerState" }).playbackRate, 0.9);
});

test("navigation re-applies a claimed speed and otherwise leaves the player alone", () => {
  const harness = createHarness();
  // A speed the learner picked in YouTube's own menu is not ours to reset.
  harness.video.playbackRate = 1.5;
  harness.fire("yt-navigate-finish");
  assert.equal(harness.video.playbackRate, 1.5);

  harness.send({ action: "setPlaybackRate", rate: 0.75 });
  // YouTube rebuilds the player on SPA navigation, so the speed starts over.
  harness.video.playbackRate = 1;
  harness.fire("yt-navigate-finish");
  assert.equal(harness.video.playbackRate, 0.75);
});

test("a stored speed is restored on load and re-applied when the player appears", async () => {
  const harness = createHarness({ stored: { [STORAGE_KEY]: 0.6 } });
  // The restore reads storage asynchronously (captions do the same).
  harness.video.playbackRate = 1;
  await harness.settle();
  assert.equal(harness.video.playbackRate, 0.6);

  // YouTube renders the player after document_idle, so the metadata event is
  // the second chance; media events do not bubble, hence the capture flag.
  const metadata = harness.documentListeners.loadedmetadata || [];
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].capture, true);
  harness.video.playbackRate = 1;
  harness.fire("loadedmetadata");
  assert.equal(harness.video.playbackRate, 0.6);
});

test("an absent stored speed is never forced onto the player", async () => {
  const harness = createHarness({ stored: {} });
  harness.video.playbackRate = 1.5;
  await harness.settle();
  assert.equal(harness.video.playbackRate, 1.5);
  assert.equal(harness.documentListeners.loadedmetadata, undefined);

  // Junk in storage must not become 0.5x on the element.
  const junk = createHarness({ stored: { [STORAGE_KEY]: "nope" } });
  junk.video.playbackRate = 1.5;
  await junk.settle();
  assert.equal(junk.video.playbackRate, 1.5);
  assert.equal(junk.documentListeners.loadedmetadata, undefined);
});
