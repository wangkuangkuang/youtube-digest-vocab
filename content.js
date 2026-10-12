/**
 * CONTENT SCRIPT
 *
 * This script runs ON the YouTube page itself. It can see and modify
 * the YouTube page DOM (the HTML elements).
 *
 * It handles:
 * 1. Extracting video info (title, channel name) from the page
 * 2. Injecting "key moment" markers onto YouTube's progress bar
 * 3. Adding a "Digest" button to YouTube's action bar (next to Share/Save)
 *
 * Think of it like a robot sitting inside the YouTube tab,
 * reading the page and making small visual changes.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Playback-speed bounds. Declared up here because init() reads the stored speed
// synchronously, before the dictation helper section below has been evaluated.
const YTD_PLAYBACK_RATE_KEY = "ytd_playback_rate";
const YTD_MIN_PLAYBACK_RATE = 0.5;
const YTD_MAX_PLAYBACK_RATE = 2;
const YTD_DEFAULT_PLAYBACK_RATE = 1;

// ============================================================
// GLOBAL STATE
// ============================================================

let ytdNoteButton = null;
let ytdNoteButtonTimer = null;
let ytdNoteKeyboardListenerAdded = false;
let ytdNoteButtonRetryTimer = null;
let ytdDigestButton = null;
let digestButtonObserver = null;
let digestButtonReconcileTimer = null;
let digestButtonResizeListenerAdded = false;

// Page-side dictation state (captions, playback speed, loop, URL watcher)
let ytdCaptionsHidden = false;
// null until this session claims a speed (restored or set by the panel), so a
// navigation never stomps a speed the learner picked in YouTube's own menu.
let ytdPlaybackRate = null;
let ytdLoopState = null;
let ytdLoopVideo = null;
let ytdUrlWatchTimer = null;
let ytdLastUrl = "";

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * When the page loads, inject our Digest button and Note button.
 * We wait a bit for YouTube's UI to fully render.
 */
function init() {
  // Register the global "n" keyboard shortcut once
  if (!ytdNoteKeyboardListenerAdded) {
    document.addEventListener("keydown", handleNoteKeyboardShortcut);
    ytdNoteKeyboardListenerAdded = true;
  }

  // Try to inject the buttons immediately
  injectDigestButton();
  tryInjectNoteButton();

  // Also set up an observer to handle YouTube's dynamic content loading
  // (YouTube is an SPA, so elements appear/disappear as you navigate)
  setupButtonObserver();
  setupDigestButtonResizeListener();

  // Restore the page-side study setup and keep it alive across navigation
  restoreCaptionsHidden();
  restorePlaybackRate();
  startUrlWatcher();
}

/**
 * Attempts to inject the note button. If the player container isn't ready yet,
 * retry a few times with a short delay. YouTube renders the player asynchronously
 * after navigation, so a single immediate attempt can miss it.
 */
function tryInjectNoteButton() {
  if (!window.location.pathname.includes("/watch")) return;

  // Clear any existing retry so we don't stack timers
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  let attempts = 0;
  const maxAttempts = 30; // ~3 seconds of retrying

  function attempt() {
    attempts++;
    const playerContainer = document.querySelector(
      "#movie_player.html5-video-player, #movie_player, .html5-video-player",
    );

    if (playerContainer) {
      injectNoteButton();
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
      return;
    }

    if (attempts >= maxAttempts) {
      debugLog(
        "[YouTube Digest Content] Player container not found after retries, giving up",
      );
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
    }
  }

  attempt();
  if (!ytdNoteButton || !ytdNoteButton.isConnected) {
    ytdNoteButtonRetryTimer = setInterval(attempt, 100);
  }
}

// Run init when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel or background script.
 * When they ask for video info, we read it from the page.
 * When they send key moments, we highlight them on the progress bar.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog("[YouTube Digest Content] Received message:", message.action, message);

  if (message.action === "getVideoInfo") {
    // Read video title and channel name from the page
    const info = extractVideoInfo();
    debugLog("[YouTube Digest Content] Returning video info:", info);
    sendResponse(info);
    return false; // Synchronous response
  }

  if (message.action === "highlightMoments") {
    // Key moment markers disabled — chapters are shown in the side panel only.
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "getCurrentTime") {
    // Return the current video playback time (used by auto-scroll)
    const video = document.querySelector("video.html5-main-video");
    sendResponse({
      currentTime: video ? Math.floor(video.currentTime) : 0,
      paused: video ? video.paused : true,
    });
    return false;
  }

  if (message.action === "seekTo") {
    // Jump the video to a specific timestamp
    debugLog("[YouTube Digest Content] Seeking to:", message.seconds);
    seekToTimestamp(message.seconds);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "showNoteSavedFeedback") {
    // Show brief feedback that note was saved
    showNoteSavedToast(message.note);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "setCaptionsHidden") {
    // Visually hide YouTube's captions; the player's own CC state is untouched
    const hidden = applyCaptionsHidden(message.hidden);
    persistCaptionsHidden(hidden);
    sendResponse({ success: true, hidden });
    return false;
  }

  if (message.action === "setLoop") {
    // Start or clear a single-sentence replay range
    const result = setLoop(message);
    debugLog("[YouTube Digest Content] Loop now:", result.loop);
    sendResponse(result);
    return false;
  }

  if (message.action === "setPlaybackRate") {
    // Dictation speed. Only the video element is touched; YouTube's own
    // speed menu and its stored preference are left alone.
    const rate = applyPlaybackRate(message.rate);
    persistPlaybackRate(rate);
    sendResponse({ success: true, rate });
    return false;
  }

  if (message.action === "getPlayerState") {
    // Snapshot of the player plus our page-side state
    sendResponse(getPlayerState());
    return false;
  }

  if (message.action === "playPause") {
    // Toggle playback (used by the dictation controls)
    sendResponse(togglePlayPause());
    return false;
  }

  if (message.action === "getChapters") {
    // Official chapters: panel list first, description text as fallback
    const { chapters, source } = readChapters();
    debugLog(
      "[YouTube Digest Content] Chapters from",
      source,
      chapters.length,
    );
    sendResponse({ success: true, chapters, source });
    return false;
  }

  // Unknown action - still send a response to prevent hanging
  debugLog("[YouTube Digest Content] Unknown action:", message.action);
  sendResponse({ success: false, error: "Unknown action" });
  return false;
});

// ============================================================
// DIGEST BUTTON INJECTION
// ============================================================

/**
 * Injects a "Digest" button into YouTube's action bar.
 * The button appears next to Share, Save, etc. below the video.
 *
 * When clicked, it opens the YouTube Digest side panel.
 */
function isVisibleDigestHost(element) {
  if (!element || !element.isConnected) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/**
 * YouTube keeps hidden copies of its responsive action toolbar in the DOM.
 * querySelector() can return one of those 0x0 copies before the toolbar the
 * viewer can actually see, so inspect every candidate and resolve the native
 * button group inside the visible action row for the current video.
 */
function findDigestButtonHost() {
  const primaryActionRows = Array.from(
    document.querySelectorAll("ytd-watch-metadata #actions-inner"),
  );

  for (const actionRow of primaryActionRows) {
    if (!isVisibleDigestHost(actionRow)) continue;

    const visibleButtonGroup = Array.from(
      actionRow.querySelectorAll("#top-level-buttons-computed"),
    ).find(isVisibleDigestHost);
    if (visibleButtonGroup) return visibleButtonGroup;
  }

  const fallbackCandidates = Array.from(
    document.querySelectorAll(
      "ytd-watch-metadata #actions #top-level-buttons-computed, " +
        "ytd-watch-metadata #top-level-buttons-computed, " +
        "#primary #actions #top-level-buttons-computed",
    ),
  );

  return (
    fallbackCandidates.find(
      (candidate) =>
        isVisibleDigestHost(candidate) &&
        (candidate.closest("ytd-watch-metadata") ||
          candidate.closest("#primary")),
    ) || null
  );
}

function createDigestButton() {
  const digestButton = document.createElement("button");
  digestButton.id = "ytd-digest-button";
  digestButton.type = "button";
  digestButton.setAttribute("aria-label", "Open YouTube Digest");
  digestButton.innerHTML = `<span class="ytd-digest-label">Digest</span>`;

  // Style the button — rounded pill in our terracotta accent, sized to sit
  // comfortably among YouTube's native action buttons.
  digestButton.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 18px;
    height: 36px;
    border: none;
    border-radius: 18px;
    background: #c8674f;
    color: white;
    font-family: "Roboto", "Arial", sans-serif;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    margin-right: 8px;
    transition: background 0.2s, transform 0.1s;
    flex: 0 0 auto;
    align-self: center;
    width: max-content;
    min-width: max-content;
    max-width: max-content;
    white-space: nowrap;
  `;

  // Hover effects
  digestButton.addEventListener("mouseenter", () => {
    digestButton.style.background = "#b25742";
    digestButton.style.transform = "scale(1.02)";
  });

  digestButton.addEventListener("mouseleave", () => {
    digestButton.style.background = "#c8674f";
    digestButton.style.transform = "scale(1)";
  });

  // Click handler — open the side panel
  digestButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    debugLog("[YouTube Digest] Digest button clicked");

    // Send message to background script to open side panel
    try {
      const result = await chrome.runtime.sendMessage({
        action: "openSidePanel",
      });
      debugLog("[YouTube Digest] openSidePanel response:", result);
    } catch (err) {
      console.error("[YouTube Digest] Failed to open side panel:", err);
    }
  });

  ytdDigestButton = digestButton;
  return digestButton;
}

/**
 * Reconciles the Digest button with YouTube's currently visible action row.
 * This is intentionally idempotent because YouTube rebuilds its watch page
 * during navigation and at responsive breakpoints.
 */
function injectDigestButton() {
  const existingButtons = Array.from(
    document.querySelectorAll("#ytd-digest-button"),
  );

  if (!window.location.pathname.includes("/watch")) {
    existingButtons.forEach((button) => button.remove());
    ytdDigestButton = null;
    return false;
  }

  const actionsContainer = findDigestButtonHost();
  if (!actionsContainer) {
    debugLog("[YouTube Digest Content] Visible actions container not found yet");
    return false;
  }

  let digestButton = existingButtons.find(
    (button) => button === ytdDigestButton,
  );

  if (!digestButton) {
    existingButtons.forEach((button) => button.remove());
    existingButtons.length = 0;
    digestButton = createDigestButton();
  }

  existingButtons.forEach((button) => {
    if (button !== digestButton) button.remove();
  });

  if (digestButton.parentElement !== actionsContainer) {
    // YouTube turns #actions-inner into a vertical flex column at narrow
    // breakpoints. A direct child there stretches into a full-width second
    // row, so keep Digest inside the native horizontal button group and
    // prepend it to preserve visibility when space is limited.
    actionsContainer.insertBefore(digestButton, actionsContainer.firstChild);
  }

  debugLog("[YouTube Digest Content] Digest button reconciled");
  return true;
}

function scheduleDigestButtonReconciliation(delay = 80) {
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
  }

  digestButtonReconcileTimer = setTimeout(() => {
    digestButtonReconcileTimer = null;
    injectDigestButton();
  }, delay);
}

function setupDigestButtonResizeListener() {
  if (digestButtonResizeListenerAdded) return;

  window.addEventListener("resize", () => {
    scheduleDigestButtonReconciliation(120);
  });
  digestButtonResizeListenerAdded = true;
}

/**
 * Sets up a MutationObserver to watch for YouTube's dynamic content changes.
 * When the action buttons container appears (after navigation), we inject our button.
 */
function setupButtonObserver() {
  if (digestButtonObserver) return;

  digestButtonObserver = new MutationObserver(() => {
    // Check if we need to inject the buttons
    if (window.location.pathname.includes("/watch")) {
      scheduleDigestButtonReconciliation();
      if (!ytdNoteButton || !ytdNoteButton.isConnected) {
        tryInjectNoteButton();
      }
    }
  });

  // Watch the entire body for changes (YouTube rebuilds large chunks of the DOM)
  digestButtonObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// ============================================================
// NOTE BUTTON (Overlay on Video Player)
// ============================================================

/**
 * Injects a "Note" button overlay on top of the YouTube video player.
 * The button appears when the mouse enters or moves over the player and hides
 * after the cursor stays still for more than 2 seconds or leaves the player.
 */
function injectNoteButton() {
  // Don't inject if we're not on a video page
  if (!window.location.pathname.includes("/watch")) return;

  // Don't inject if button already exists and is properly tracked.
  // If a stale button exists (e.g., from a previous content-script instance),
  // remove it and re-inject so event listeners are attached to the live one.
  const existingButton = document.getElementById("ytd-note-button");
  if (existingButton) {
    if (ytdNoteButton === existingButton && existingButton.isConnected) {
      return; // already injected and connected
    }
    existingButton.remove();
  }

  // Find the video player container. YouTube rebuilds this dynamically, so
  // we try the most common selectors.
  const playerContainer = document.querySelector(
    "#movie_player.html5-video-player, " +
      "#movie_player, " +
      ".html5-video-player",
  );

  if (!playerContainer) {
    debugLog(
      "[YouTube Digest Content] Player container not found yet, will retry",
    );
    return;
  }

  // Ensure the player container has relative positioning for absolute children
  if (
    window.getComputedStyle(playerContainer).position === "static" ||
    !playerContainer.style.position
  ) {
    playerContainer.style.position = "relative";
  }

  debugLog("[YouTube Digest Content] Injecting note button");

  // Create the note button — a soft rounded pill that floats over the player
  const noteButton = document.createElement("button");
  noteButton.id = "ytd-note-button";
  noteButton.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right: 7px;">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
    </svg>
    <span>Note</span>
  `;

  // Soft rounded pill in the terracotta accent, with a gentle shadow.
  // Start hidden; visibility is controlled by mouse activity.
  noteButton.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 9999;
    display: flex;
    align-items: center;
    padding: 9px 16px;
    background: #c8674f;
    color: white;
    border: none;
    border-radius: 999px;
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.2px;
    cursor: pointer;
    transition: opacity 0.18s ease, transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
    opacity: 0;
    pointer-events: none;
    box-shadow: 0 4px 14px rgba(0,0,0,0.3);
  `;

  ytdNoteButton = noteButton;

  // Show button when mouse enters or moves over the player.
  // Hide after 2 seconds of idle or when the mouse leaves.
  playerContainer.addEventListener("mouseenter", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mousemove", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mouseleave", () => {
    clearTimeout(ytdNoteButtonTimer);
    ytdNoteButtonTimer = null;
    hideNoteButton();
  });

  // Hover effect — lift slightly
  noteButton.addEventListener("mouseenter", () => {
    noteButton.style.background = "#b25742";
    noteButton.style.boxShadow = "0 6px 18px rgba(0,0,0,0.35)";
    noteButton.style.transform = "translateY(-1px)";
  });

  noteButton.addEventListener("mouseleave", () => {
    noteButton.style.background = "#c8674f";
    noteButton.style.boxShadow = "0 4px 14px rgba(0,0,0,0.3)";
    noteButton.style.transform = "translateY(0)";
  });

  // Click handler — save the current moment as a note
  noteButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await saveCurrentNote();
  });

  playerContainer.appendChild(noteButton);

  debugLog("[YouTube Digest Content] Note button injected");
}

function showNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "1";
  ytdNoteButton.style.pointerEvents = "auto";
}

function hideNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "0";
  ytdNoteButton.style.pointerEvents = "none";
}

function resetNoteButtonTimer() {
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = setTimeout(() => {
    hideNoteButton();
  }, 2000);
}

/**
 * Handles the "n" keyboard shortcut for saving a note.
 * Only triggers on YouTube watch pages and when the user is not typing
 * in an input field.
 */
function handleNoteKeyboardShortcut(e) {
  if (!window.location.pathname.includes("/watch")) return;
  if (e.key !== "n" && e.key !== "N") return;

  // Ignore if the user is typing in an input/textarea/contenteditable
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  ) {
    return;
  }

  // Prevent YouTube's own "n" shortcut (e.g. next video in playlist)
  e.preventDefault();
  e.stopPropagation();

  // Show brief visual feedback on the button, then save
  showNoteButton();
  resetNoteButtonTimer();
  saveCurrentNote();
}

/**
 * Captures the current timestamp and saves it as a note.
 */
async function saveCurrentNote() {
  debugLog("[YouTube Digest] Saving note");

  const video = document.querySelector("video.html5-main-video");
  if (!video) {
    console.error("[YouTube Digest] No video element found");
    return;
  }

  // Go back 3 seconds to capture what was just said (user reacts after hearing it)
  const currentTime = Math.max(0, Math.floor(video.currentTime) - 3);
  const videoInfo = extractVideoInfo();
  const videoId = new URLSearchParams(window.location.search).get("v");

  const noteButton = ytdNoteButton;
  const originalContent = noteButton ? noteButton.innerHTML : "";

  if (noteButton) {
    noteButton.innerHTML =
      '<span style="letter-spacing: 0.2px;">SAVING...</span>';
    noteButton.style.pointerEvents = "none";
  }

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: videoId,
      timestamp: currentTime,
      videoTitle: videoInfo.title,
      channelName: videoInfo.channelName,
    });

    if (result.success) {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">SAVED</span>';
        noteButton.style.background = "#7c8b6f";
      }
      showNoteSavedToast(result.note);
    } else {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">ERROR</span>';
      }
      console.error("[YouTube Digest] Save note error:", result.error);
    }
  } catch (err) {
    if (noteButton) {
      noteButton.innerHTML =
        '<span style="letter-spacing: 0.2px;">ERROR</span>';
    }
    console.error("[YouTube Digest] Save note exception:", err);
  }

  setTimeout(() => {
    if (noteButton) {
      noteButton.innerHTML = originalContent;
      noteButton.style.background = "#c8674f";
      noteButton.style.pointerEvents = "auto";
    }
  }, 2000);
}

/**
 * Shows a toast notification when a note is saved.
 */
function showNoteSavedToast(note) {
  // Remove existing toast
  const existing = document.getElementById("ytd-note-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "ytd-note-toast";
  toast.innerHTML = `
    <div style="font-weight: 700; margin-bottom: 6px; color: #c8674f;">Note saved</div>
    <div style="font-size: 12px; color: #6b6258; margin-bottom: 8px;">${escapeHtmlForContent(note.timestamp)} — ${escapeHtmlForContent(note.videoTitle)}</div>
    <div style="font-size: 13px; line-height: 1.55; color: #2e2a24;">"${escapeHtmlForContent(note.text)}"</div>
    <div style="margin-top: 10px; font-size: 11px;">
      <a href="${escapeHtmlForContent(note.timestampedUrl)}" style="color: #c8674f; font-weight: 600; text-decoration: none;">Copy link</a>
    </div>
  `;

  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    background: #ffffff;
    border: 1px solid #ece5d9;
    border-radius: 14px;
    padding: 16px 20px;
    max-width: 350px;
    box-shadow: 0 12px 32px rgba(50, 42, 32, 0.2);
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    animation: ytdSlideIn 0.3s ease;
  `;

  // Add animation keyframes
  const style = document.createElement("style");
  style.textContent = `
    @keyframes ytdSlideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  // Copy link handler
  toast.querySelector("a").addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(note.timestampedUrl);
      e.target.textContent = "Copied";
    } catch (err) {
      console.error("Copy failed:", err);
    }
  });

  document.body.appendChild(toast);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.style.animation = "ytdSlideIn 0.3s ease reverse";
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Reads the video title, channel name, and description directly from YouTube's page.
 * These are just sitting in the HTML — we grab them from the DOM elements.
 */
function extractVideoInfo() {
  // The video title is in an h1 element inside the #title container
  const titleElement = document.querySelector(
    "h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string",
  );

  // The channel name is in the channel info section
  const channelElement = document.querySelector(
    "#channel-name yt-formatted-string a, ytd-channel-name yt-formatted-string a",
  );

  // Video duration from the video element
  const videoElement = document.querySelector("video.html5-main-video");

  // Video description — YouTube has this in a few possible places
  const descriptionElement = document.querySelector(
    "#description-inner, " +
      "ytd-watch-metadata #description yt-attributed-string, " +
      "#description yt-formatted-string, " +
      "ytd-expander#description yt-attributed-string",
  );

  return {
    title: titleElement?.textContent?.trim() || "",
    channelName: channelElement?.textContent?.trim() || "",
    duration: videoElement?.duration || 0,
    description: descriptionElement?.textContent?.trim() || "",
  };
}

// ============================================================
// PROGRESS BAR KEY MOMENTS
// ============================================================

/**
 * Adds colored marker dots to YouTube's video progress bar
 * at the positions of key moments identified by the AI provider.
 *
 * How it works:
 * - YouTube's progress bar is a <div> element with a known class
 * - We calculate each moment's position as a percentage of total duration
 * - We inject small colored <div> elements at those positions
 * - The markers are absolutely positioned on top of the progress bar
 *
 * This is a "bonus feature" — it gives you a visual preview
 * of where the good stuff is in the video.
 */
function highlightKeyMoments(moments, videoDuration) {
  // Disabled: no timeline markers. Chapters live only in the side panel.
  return;
}

// ============================================================
// SEEK TO TIMESTAMP
// ============================================================

/**
 * Jumps the YouTube video to a specific timestamp (in seconds).
 * This is called when the user clicks a timestamp in the side panel.
 *
 * We simply set the video element's .currentTime property,
 * which is the standard HTML5 way to seek in a video.
 */
function seekToTimestamp(seconds) {
  const video = document.querySelector("video.html5-main-video");
  if (!video) {
    console.error("[YouTube Digest Content] No video element found for seek");
    return;
  }

  debugLog("[YouTube Digest Content] Seeking to:", seconds);
  video.currentTime = seconds;
  // Also play the video if it's paused
  if (video.paused) {
    video.play().catch(() => {}); // Ignore autoplay errors
  }
}

function escapeHtmlForContent(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

// ============================================================
// DICTATION PAGE HELPERS (CAPTIONS, PLAYBACK RATE, LOOP, CHAPTERS)
// ============================================================

const YTD_CAPTIONS_STYLE_ID = "ytd-captions-style";
const YTD_LOOP_END_EPSILON = 0.05;

/**
 * Hide only the rendered caption boxes. The native CC button and the
 * preference YouTube stores for it are deliberately left alone, so we never
 * fight the player's own subtitle state.
 */
const YTD_CAPTIONS_CSS = `
  .ytp-caption-window-container,
  .ytp-caption-window-container .caption-window,
  .ytp-caption-window-container .captions-text,
  .caption-window,
  .ytp-caption-segment,
  .ytp-chrome-bottom .ytp-caption-window-container {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
  }
`;

function getVideoElement() {
  return document.querySelector("video.html5-main-video");
}

/**
 * Applies the caption visibility state to the page and returns the state that
 * is actually in effect. The injected style tag is the source of truth, so
 * calling this again after navigation simply re-adds it if YouTube dropped it.
 */
function applyCaptionsHidden(hidden) {
  const existingStyle = document.getElementById(YTD_CAPTIONS_STYLE_ID);

  if (hidden) {
    if (!existingStyle) {
      const style = document.createElement("style");
      style.id = YTD_CAPTIONS_STYLE_ID;
      style.textContent = YTD_CAPTIONS_CSS;
      (document.head || document.documentElement || document.body).appendChild(
        style,
      );
    }
  } else if (existingStyle) {
    existingStyle.remove();
  }

  ytdCaptionsHidden = !!hidden;
  debugLog("[YouTube Digest Content] Captions hidden:", ytdCaptionsHidden);
  return ytdCaptionsHidden;
}

/**
 * Persists the caption choice so a reload keeps the same study setup.
 */
function persistCaptionsHidden(hidden) {
  try {
    const result = chrome.storage.local.set({ ytd_captions_hidden: !!hidden });
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch (err) {
    debugLog("[YouTube Digest Content] Could not persist captions:", err);
  }
}

/**
 * Restores the last caption choice on extension startup.
 */
function restoreCaptionsHidden() {
  try {
    const result = chrome.storage.local.get("ytd_captions_hidden");
    if (!result || typeof result.then !== "function") return;

    result
      .then((data) => applyCaptionsHidden(!!data?.ytd_captions_hidden))
      .catch((err) =>
        debugLog("[YouTube Digest Content] Caption restore failed:", err),
      );
  } catch (err) {
    debugLog("[YouTube Digest Content] Caption restore unavailable:", err);
  }
}

/**
 * Clamps a requested speed into [0.5, 2], the same bounds the side panel's
 * gears stay inside. Missing, empty and non-numeric input means normal speed.
 * Chrome's own pitch preservation (preservesPitch) is deliberately untouched,
 * so only the tempo changes.
 */
function clampPlaybackRate(value) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return YTD_DEFAULT_PLAYBACK_RATE;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return YTD_DEFAULT_PLAYBACK_RATE;
  return Math.min(Math.max(num, YTD_MIN_PLAYBACK_RATE), YTD_MAX_PLAYBACK_RATE);
}

/**
 * Applies a speed to the player and returns the rate actually in effect. A
 * missing video element (player still rendering) still records the choice, so
 * the next navigation or metadata load applies it.
 */
function applyPlaybackRate(rate) {
  const value = clampPlaybackRate(rate);
  const video = getVideoElement();
  if (video) video.playbackRate = value;
  ytdPlaybackRate = value;
  debugLog("[YouTube Digest Content] Playback rate:", ytdPlaybackRate);
  return ytdPlaybackRate;
}

/**
 * Persists the speed choice so a reload keeps the same study setup.
 */
function persistPlaybackRate(rate) {
  try {
    const result = chrome.storage.local.set({
      [YTD_PLAYBACK_RATE_KEY]: clampPlaybackRate(rate),
    });
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch (err) {
    debugLog("[YouTube Digest Content] Could not persist playback rate:", err);
  }
}

/**
 * Restores the last speed on extension startup. Unlike the caption overlay, an
 * absent setting changes nothing: forcing 1x on every reload would fight a
 * speed the learner picked in YouTube's own menu.
 */
function restorePlaybackRate() {
  try {
    const result = chrome.storage.local.get(YTD_PLAYBACK_RATE_KEY);
    if (!result || typeof result.then !== "function") return;

    result
      .then((data) => {
        const stored = Number(data?.[YTD_PLAYBACK_RATE_KEY]);
        // 0/NaN also covers null, undefined and the empty string.
        if (!Number.isFinite(stored) || stored <= 0) return;
        applyPlaybackRate(stored);
        // YouTube renders the player after document_idle, so the apply above
        // can run against a page that has no video element yet.
        document.addEventListener(
          "loadedmetadata",
          reapplyPlaybackRate,
          true,
        );
      })
      .catch((err) =>
        debugLog("[YouTube Digest Content] Playback rate restore failed:", err),
      );
  } catch (err) {
    debugLog("[YouTube Digest Content] Playback rate restore unavailable:", err);
  }
}

/**
 * Re-applies the claimed speed once a source is loaded. Media events do not
 * bubble, hence the capture flag on the listener registered above.
 */
function reapplyPlaybackRate() {
  if (ytdPlaybackRate === null) return;
  applyPlaybackRate(ytdPlaybackRate);
}

/**
 * Clamps a timestamp into [0, max]. Non-finite values collapse to 0.
 */
function clampSeconds(value, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(Math.max(num, 0), max);
}

/**
 * The loop end in seconds. A null end means "up to the video duration",
 * resolved lazily so a loop set before metadata is loaded still works.
 */
function resolveLoopEnd() {
  if (!ytdLoopState) return null;
  if (ytdLoopState.end !== null) return ytdLoopState.end;

  const video = getVideoElement();
  if (!video || !Number.isFinite(video.duration)) return null;
  return video.duration;
}

/**
 * Plain snapshot of the active loop for the side panel (null when inactive).
 */
function describeLoop() {
  if (!ytdLoopState) return null;

  return {
    start: ytdLoopState.start,
    end: resolveLoopEnd(),
    mode: ytdLoopState.mode,
  };
}

/**
 * Replays the segment once playback reaches its end. In "once" mode the video
 * is paused and the loop is cleared, which is what a single-sentence repeat
 * needs; "loop" keeps playing from the start indefinitely.
 */
function handleLoopTimeUpdate(event) {
  if (!ytdLoopState) return;

  const video = event?.currentTarget || getVideoElement();
  if (!video) return;

  const end = resolveLoopEnd();
  // No usable end yet (metadata still loading) or an empty range: do nothing.
  if (end === null || end <= ytdLoopState.start) return;
  if (video.currentTime < end - YTD_LOOP_END_EPSILON) return;

  const { start, mode } = ytdLoopState;
  video.currentTime = start;
  debugLog("[YouTube Digest Content] Loop replay at", start, mode);

  if (mode === "once") {
    video.pause();
    clearLoop();
  }
}

function attachLoopListener(video) {
  if (!video || ytdLoopVideo === video) return;

  detachLoopListener();
  video.addEventListener("timeupdate", handleLoopTimeUpdate);
  ytdLoopVideo = video;
}

function detachLoopListener() {
  if (!ytdLoopVideo) return;

  ytdLoopVideo.removeEventListener("timeupdate", handleLoopTimeUpdate);
  ytdLoopVideo = null;
}

function clearLoop() {
  detachLoopListener();
  ytdLoopState = null;
}

/**
 * Sets or clears the single replay range. Returns the range actually in
 * effect, or null when the requested one is unusable.
 */
function setLoop(payload) {
  if (payload.enabled === false) {
    clearLoop();
    return { success: true, loop: null };
  }

  const video = getVideoElement();
  const duration =
    video && Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : 0;
  const maxSeconds = duration > 0 ? duration : Infinity;
  const start = clampSeconds(payload.start, maxSeconds);

  let end = null;
  if (payload.end !== null && payload.end !== undefined) {
    end = clampSeconds(payload.end, maxSeconds);
    if (end <= start) {
      debugLog("[YouTube Digest Content] Rejecting loop end <= start");
      clearLoop();
      return { success: true, loop: null };
    }
  } else if (duration > 0 && duration <= start) {
    debugLog("[YouTube Digest Content] Rejecting loop start past video end");
    clearLoop();
    return { success: true, loop: null };
  }

  ytdLoopState = {
    start,
    end,
    mode: payload.mode === "once" ? "once" : "loop",
  };
  attachLoopListener(video);

  return { success: true, loop: describeLoop() };
}

/**
 * Snapshot used by the dictation controls: playback position plus our
 * page-side state (captions, speed and loop).
 */
function getPlayerState() {
  const video = getVideoElement();

  return {
    success: true,
    currentTime: video ? video.currentTime : 0,
    duration: video && Number.isFinite(video.duration) ? video.duration : 0,
    paused: video ? video.paused : true,
    captionsHidden: ytdCaptionsHidden,
    // The element wins: it is the one the learner actually hears.
    playbackRate: video
      ? video.playbackRate
      : (ytdPlaybackRate ?? YTD_DEFAULT_PLAYBACK_RATE),
    loop: describeLoop(),
  };
}

/**
 * Toggles playback. The reported state is computed before the call so it does
 * not depend on the async play() promise.
 */
function togglePlayPause() {
  const video = getVideoElement();
  if (!video) {
    return { success: false, paused: true, error: "No video element found" };
  }

  const shouldPause = !video.paused;
  if (shouldPause) {
    video.pause();
  } else {
    video.play().catch(() => {}); // Ignore autoplay errors
  }

  debugLog("[YouTube Digest Content] playPause ->", shouldPause);
  return { success: true, paused: shouldPause };
}

/**
 * Parses "mm:ss" or "h:mm:ss" into seconds. Returns null when the text holds
 * no usable timestamp.
 */
function parseTimestampToSeconds(text) {
  if (!text) return null;

  const match = String(text).match(/(?:(\d{1,3}):)?(\d{1,2}):([0-5]\d)/);
  if (!match) return null;

  const hours = match[1] ? Number(match[1]) : 0;
  return hours * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** A chapter line in the description: "0:00 Intro", "1:02:33 Deep dive". */
const YTD_CHAPTER_LINE_PATTERN =
  /^\s*(?:(\d{1,3}):)?(\d{1,2}):([0-5]\d)\s+(.+?)\s*$/;

/**
 * Chapters from the player's macro-markers list (time in #time, title in the
 * heading link). YouTube renders hidden copies of this list, so duplicates by
 * start time are dropped.
 */
function getChaptersFromPanel() {
  const items = document.querySelectorAll(
    'ytd-engagement-panel-section-list-renderer[target-id*="chapters"] ' +
      "ytd-macro-markers-list-item-renderer, " +
      "ytd-macro-markers-list-item-renderer",
  );

  const chapters = [];
  const seenStarts = new Set();

  items.forEach((item) => {
    const timeText = item.querySelector("#time")?.textContent?.trim() || "";
    const titleText =
      item
        .querySelector("h3 a yt-formatted-string, h3 a, h3 yt-formatted-string, h3")
        ?.textContent?.trim() || "";
    const startSeconds = parseTimestampToSeconds(timeText);

    if (startSeconds === null || seenStarts.has(startSeconds)) return;

    seenStarts.add(startSeconds);
    chapters.push({ title: titleText || timeText, startSeconds });
  });

  return chapters.sort((a, b) => a.startSeconds - b.startSeconds);
}

/**
 * Fallback: chapters parsed from the description text. YouTube gives every
 * chapter its own block, so innerText keeps one chapter per line even when the
 * timestamps are not rendered as links.
 */
function getChaptersFromDescription() {
  const container = document.querySelector(
    "#description-inline-expander, ytd-watch-metadata #description, " +
      "#description-inner",
  );
  if (!container) return [];

  const text = container.innerText || container.textContent || "";
  const chapters = [];
  const seenStarts = new Set();

  text.split("\n").forEach((line) => {
    const match = line.match(YTD_CHAPTER_LINE_PATTERN);
    if (!match) return;

    const hours = match[1] ? Number(match[1]) : 0;
    const startSeconds =
      hours * 3600 + Number(match[2]) * 60 + Number(match[3]);
    if (seenStarts.has(startSeconds)) return;

    seenStarts.add(startSeconds);
    chapters.push({ title: match[4], startSeconds });
  });

  return chapters.sort((a, b) => a.startSeconds - b.startSeconds);
}

/**
 * Reads the video's official chapters: panel list first, description second.
 */
function readChapters() {
  const panelChapters = getChaptersFromPanel();
  if (panelChapters.length) return { chapters: panelChapters, source: "panel" };

  const descriptionChapters = getChaptersFromDescription();
  if (descriptionChapters.length) {
    return { chapters: descriptionChapters, source: "description" };
  }

  return { chapters: [], source: "none" };
}

/**
 * Resets state that belongs to a single video. Captions and an explicitly set
 * playback speed are page-level preferences, so they are simply re-applied to
 * the new page.
 */
function resetPageSideState() {
  clearLoop();
  applyCaptionsHidden(ytdCaptionsHidden);
  if (ytdPlaybackRate !== null) applyPlaybackRate(ytdPlaybackRate);
}

/**
 * YouTube swaps videos without reloading, and the player element is rebuilt.
 * yt-navigate-finish covers normal navigation; the URL watcher catches cases
 * that bypass it (miniplayer, history API updates) so the loop can never drag
 * on into the next video.
 */
document.addEventListener("yt-navigate-finish", resetPageSideState);

function startUrlWatcher() {
  ytdLastUrl = window.location.href;
  if (ytdUrlWatchTimer) return;

  ytdUrlWatchTimer = setInterval(() => {
    const href = window.location.href;
    if (href === ytdLastUrl) return;

    ytdLastUrl = href;
    debugLog("[YouTube Digest Content] URL changed, resetting page state");
    resetPageSideState();
  }, 1000);
}

// ============================================================
// PAGE NAVIGATION DETECTION
// ============================================================

/**
 * YouTube is a "Single Page Application" (SPA). This means when you
 * click on a new video, the page doesn't fully reload — YouTube
 * dynamically swaps out the content. So our content script stays alive
 * but needs to detect when the video changes.
 *
 * We watch for URL changes using the `yt-navigate-finish` event,
 * which YouTube fires after navigation completes. When that happens,
 * we clean up old markers and re-inject the button.
 */
document.addEventListener("yt-navigate-finish", () => {
  // Clean up old key moment markers when navigating to a new video
  const existingMarkers = document.querySelectorAll(".ytd-key-moment-markers");
  existingMarkers.forEach((m) => m.remove());

  // Remove old buttons (they will be re-injected for the new video)
  document
    .querySelectorAll("#ytd-digest-button")
    .forEach((button) => button.remove());
  ytdDigestButton = null;
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
    digestButtonReconcileTimer = null;
  }

  const existingNoteButton = document.getElementById("ytd-note-button");
  if (existingNoteButton) existingNoteButton.remove();

  // Reset note button state
  ytdNoteButton = null;
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = null;
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  // Remove any toasts
  const existingToast = document.getElementById("ytd-note-toast");
  if (existingToast) existingToast.remove();

  // Re-inject buttons for the new video (with a small delay for YouTube to render)
  setTimeout(() => {
    scheduleDigestButtonReconciliation(0);
    tryInjectNoteButton();
  }, 500);
});
