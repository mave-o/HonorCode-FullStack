// background.js
// The brain of the extension (a Manifest V3 service worker).
//
// What it does:
//   1. Listens to browser events (tab switches, focus loss, idle, URL changes).
//   2. While tracking is ON, turns them into small event records in a buffer.
//   3. Sends the buffer to the backend in batches (timer + size rules, retries).
//   4. Ends the session cleanly: upload everything left, then tell the server.
//
// IMPORTANT: the browser puts this worker to sleep when idle and wipes its
// memory. So everything that matters is kept in chrome.storage.local, and
// every listener is registered at the top level (not inside a function).

import { CONFIG } from "./config.js";
import { apiPost } from "./api.js";

// =====================================================================
// 1. STORED STATE
// =====================================================================

// Everything the worker must remember between wake-ups.
const DEFAULTS = {
  state: "idle",        // "idle" | "monitoring" | "flushing"
  session: null,        // { sessionId, quizId, quizPrefix, startedAtMs }
  seq: 0,               // last event number used in this session (1, 2, 3...)
  buffer: [],           // events recorded but not yet put in a batch
  inflight: null,       // the batch currently being sent: { batch_id, events }
  pendingEnd: null,     // set when stopping: { end_reason, ended_at }
  quizTabId: null,      // id of the tab where the quiz is open
  away: null,           // set while the student is on another tab: { since, domain, category }
  unfocusedSince: null, // time (ms) the whole browser lost focus, or null
  lastFlushAt: 0,       // time (ms) of the last successful upload
  retryCount: 0,        // consecutive failed uploads (drives the backoff)
  nextRetryAt: 0,       // do not try uploading again before this time (ms)
  lastError: null       // short text shown in the popup when something fails
};
const STATE_KEYS = Object.keys(DEFAULTS);

// Reads the stored state. `auth` and `authExpired` are written by the popup,
// so they are loaded here but never saved back from here (avoids overwriting).
async function load() {
  return chrome.storage.local.get({ ...DEFAULTS, auth: null, authExpired: false });
}

// Writes only this worker's own keys back to storage.
async function save(s) {
  const out = {};
  for (const k of STATE_KEYS) out[k] = s[k];
  await chrome.storage.local.set(out);
}

// =====================================================================
// 2. SERIAL QUEUE
// Many browser events can fire at the same instant. Each one does
// load -> change -> save. Without a queue two of them could load the same
// old state and overwrite each other's changes. This runs them one by one.
// =====================================================================
let chain = Promise.resolve();
function serial(task) {
  const run = chain.then(task);
  chain = run.catch((e) => console.error("[HonorCode]", e)); // a failure must not block the queue
  return run;
}

// Runs `fn(s, add, nowMs)` on the loaded state, then saves it.
//  - s      : the state object (change it freely, it is saved afterwards)
//  - add    : add(type, extra, urgent) records one event
//  - nowMs  : the time the browser event happened
// By default it does nothing unless tracking is ON (opts.always overrides this).
function withState(fn, opts = {}) {
  // Capture the time NOW, before waiting in the queue, so slow uploads
  // never make an event look like it happened later than it did.
  const nowMs = Date.now();
  const ts = new Date(nowMs).toISOString();

  return serial(async () => {
    const s = await load();
    if (!opts.always && s.state !== "monitoring") return;

    let wantFlush = false;
    const add = (type, extra = {}, urgent = false) => {
      addEvent(s, type, ts, extra);
      // Urgent events, and any visit to an AI tool, are uploaded immediately.
      if (urgent || extra.category === "ai_tool") wantFlush = true;
    };

    await fn(s, add, nowMs);
    await save(s);
    updateBadge(s);

    // Upload now if: urgent event, batch is full, or the flush interval passed.
    const due = nowMs - s.lastFlushAt >= CONFIG.FLUSH_INTERVAL_MS;
    if (wantFlush || s.buffer.length >= CONFIG.BATCH_SIZE || (due && s.buffer.length > 0)) {
      syncNow(); // not awaited on purpose: the network must not block the queue
    }
  }).catch((e) => console.error("[HonorCode]", e));
}

// Runs `fn(s)` on the loaded state and saves it. Used after network calls.
function mutate(fn) {
  return serial(async () => {
    const s = await load();
    const result = await fn(s);
    await save(s);
    updateBadge(s);
    return result;
  });
}

// =====================================================================
// 3. EVENT RECORDING
// =====================================================================

// Adds one event to the buffer. Events are only recorded while tracking is ON.
// Every event gets the next sequence number, so the server can spot gaps.
function addEvent(s, type, ts, extra = {}) {
  if (s.state !== "monitoring") return false;
  s.seq += 1;
  s.buffer.push({
    seq: s.seq,
    type,
    client_ts: ts,
    domain: extra.domain ?? null,       // site domain only, never a full URL
    category: extra.category ?? null,   // ai_tool, search, notes_docs, other...
    duration_ms: extra.duration_ms ?? null,
    detail: extra.detail ?? null        // small extra info, e.g. idle state
  });
  // Safety cap: during a very long outage, drop the oldest events.
  if (s.buffer.length > CONFIG.MAX_BUFFER) {
    s.buffer.shift();
    s.lastError = "Upload backlog full: oldest events were dropped.";
  }
  return true;
}

// Turns a full URL into just a domain + category. Privacy: paths, search
// queries and page titles are deliberately thrown away here.
function classify(url) {
  if (!url) return { domain: "unknown", category: "other" };
  let u;
  try { u = new URL(url); } catch { return { domain: "unknown", category: "other" }; }

  // Local files (e.g. a PDF opened from disk).
  if (u.protocol === "file:") return { domain: "file://", category: "local_file" };
  // Browser pages such as edge://newtab or extension pages.
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { domain: `${u.protocol}//${u.hostname}`, category: "browser_internal" };
  }
  // Normal websites: drop "www." and match against the category rules.
  const host = u.hostname.replace(/^www\./, "");
  for (const rule of CONFIG.CATEGORY_RULES) {
    const hit = rule.domains.some((d) => host === d || (!rule.exact && host.endsWith("." + d)));
    if (hit) return { domain: host, category: rule.category };
  }
  return { domain: host, category: "other" };
}

// =====================================================================
// 4. BROWSER EVENT LISTENERS (all registered at the top level)
// =====================================================================

// The student switched to a different tab.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  withState(async (s, add, now) => {
    const tab = await chrome.tabs.get(tabId).catch(() => null); // tab may already be gone
    const info = classify(tab && (tab.url || tab.pendingUrl));

    if (tabId === s.quizTabId) {
      // Back on the quiz tab: close the "away" period and record how long it lasted.
      if (s.away) {
        add("tab_returned", { domain: s.away.domain, category: s.away.category, duration_ms: now - s.away.since });
        s.away = null;
      }
    } else if (!s.away) {
      // First step away from the quiz tab.
      s.away = { since: now, domain: info.domain, category: info.category };
      add("tab_left", info);
    } else {
      // Already away; hopped between two other tabs.
      s.away.domain = info.domain;
      s.away.category = info.category;
      add("tab_switched", info);
    }
  });
});

// A tab's address changed (navigation, or the quiz form moving to its confirmation page).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return; // ignore loading/title updates, we only care about URL changes

  withState(async (s, add, now) => {
    if (tabId === s.quizTabId) {
      if (changeInfo.url.includes("/formResponse")) {
        // Google Forms shows /formResponse after a successful submit: end automatically.
        add("quiz_submitted", classify(changeInfo.url), true);
        beginStop(s, add, "auto_submit", now);
      } else if (!changeInfo.url.startsWith(s.session.quizPrefix)) {
        // The quiz tab itself was sent somewhere else.
        add("quiz_tab_navigated", classify(changeInfo.url), true);
      }
      return;
    }
    // Another tab went to a new address while the student was looking at it.
    if (tab.active) {
      const info = classify(changeInfo.url);
      if (s.away) { s.away.domain = info.domain; s.away.category = info.category; }
      add("tab_navigated", info);
    }
  });
});

// The quiz tab was closed.
chrome.tabs.onRemoved.addListener((tabId) => {
  withState(async (s, add) => {
    if (tabId === s.quizTabId) {
      add("quiz_tab_closed", {}, true);
      s.quizTabId = null;
    }
  });
});

// The whole browser window gained or lost focus (e.g. the student opened Word).
// The extension cannot see WHICH app took focus, only that the browser lost it.
chrome.windows.onFocusChanged.addListener((windowId) => {
  withState(async (s, add, now) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      if (!s.unfocusedSince) {
        s.unfocusedSince = now;
        add("browser_unfocused", {}, true);
      }
    } else if (s.unfocusedSince) {
      add("browser_focused", { duration_ms: now - s.unfocusedSince });
      s.unfocusedSince = null;
    }
  });
});

// Idle / locked-screen changes. The 60 s setting means "idle" is reported
// after one minute without keyboard or mouse input.
chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((newState) => {
  withState(async (s, add) => {
    add("idle_state", { detail: newState }, newState !== "active");
  });
});

// =====================================================================
// 5. STARTING AND STOPPING A SESSION
// =====================================================================

// A quiz tab is valid if it matches the Google Forms prefix (or dev mode is on).
function isAllowedQuizUrl(url) {
  return !!url && (CONFIG.ALLOW_ANY_PAGE_AS_QUIZ || url.startsWith(CONFIG.QUIZ_URL_PREFIX));
}

// Pulls the form's ID out of the URL to use as the quiz_id.
function extractQuizId(url) {
  const m = url.match(/\/forms\/d\/(?:e\/)?([^/?#]+)/);
  if (m) return m[1];
  try { return "page-" + new URL(url).hostname; } catch { return "unknown"; }
}

let starting = false; // blocks a double-click on Start

// Called when the student presses "Turn on tracking" in the popup.
async function startMonitoring(tab) {
  if (starting) return { ok: false, error: "Already starting." };
  starting = true;
  try {
    // Step 1: check everything is OK before contacting the server.
    const s = await load();
    if (!s.auth) return { ok: false, error: "Please log in first." };
    if (s.authExpired) return { ok: false, error: "Your login expired. Log in again." };
    if (s.state !== "idle") return { ok: false, error: "Tracking is already running." };
    if (!tab || !isAllowedQuizUrl(tab.url)) {
      return { ok: false, error: "Open your quiz tab first, then turn tracking on from that tab." };
    }
    const quizPrefix = tab.url.startsWith(CONFIG.QUIZ_URL_PREFIX)
      ? CONFIG.QUIZ_URL_PREFIX
      : new URL(tab.url).origin + "/";

    // Step 2: ask the server to create the session (it returns the session_id).
    const res = await apiPost("/api/session/start",
      { quiz_id: extractQuizId(tab.url), client_ts: new Date().toISOString() }, s.auth.token);
    if (!res.ok) {
      if (res.status === 401) await chrome.storage.local.set({ authExpired: true });
      return { ok: false, error: res.message };
    }

    // Step 3: only now switch tracking on, with a clean slate.
    await withState(async (st, add, now) => {
      Object.assign(st, {
        state: "monitoring",
        session: {
          sessionId: res.data.session_id,
          quizId: extractQuizId(tab.url),
          quizPrefix,
          startedAtMs: now
        },
        seq: 0, buffer: [], inflight: null, pendingEnd: null,
        quizTabId: tab.id, away: null, unfocusedSince: null,
        lastFlushAt: now, retryCount: 0, nextRetryAt: 0, lastError: null
      });
      add("monitoring_started", classify(tab.url), true);
    }, { always: true });
    return { ok: true };
  } finally {
    starting = false;
  }
}

// Moves a session from "monitoring" to "flushing". It only changes the state;
// the actual upload and the server notification happen in syncNow().
function beginStop(s, add, reason, nowMs) {
  add("monitoring_stopped", { detail: reason }, true); // last event of the session
  s.state = "flushing";                                // recording stops from here
  s.pendingEnd = { end_reason: reason, ended_at: new Date(nowMs).toISOString() };
  s.away = null;
  s.unfocusedSince = null;
}

// Called when the student presses "Turn off tracking".
async function stopMonitoring() {
  if (!CONFIG.ALLOW_MANUAL_STOP) return { ok: false, error: "Tracking ends automatically when you submit the quiz." };
  await withState(async (s, add, now) => beginStop(s, add, "manual", now));
  return { ok: true };
}

// =====================================================================
// 6. UPLOADING (batching, timeout, retry, finish)
// =====================================================================

let syncing = false; // only one upload loop runs at a time

// Uploads everything waiting, then (if stopping) closes the session.
async function syncNow() {
  if (syncing) return;
  syncing = true;
  try {
    await flushBuffer();
    await finalizeSession();
  } catch (e) {
    console.error("[HonorCode] sync failed", e);
  } finally {
    syncing = false;
  }
}

// Sends batches until the buffer is empty or something fails.
async function flushBuffer() {
  while (true) {
    // (a) Decide what to send. Short, inside the queue.
    const plan = await mutate(async (s) => {
      if (!s.auth || !s.session || s.authExpired) return null;       // cannot upload right now
      if (Date.now() < s.nextRetryAt) return null;                   // still in backoff
      if (!s.inflight) {
        if (s.buffer.length === 0) return null;                      // nothing to send
        // Move up to MAX_BATCH events into a new batch with its own ID.
        // If the send fails, the SAME batch (same ID) is retried, so the
        // server can ignore a duplicate instead of writing rows twice.
        s.inflight = { batch_id: crypto.randomUUID(), events: s.buffer.splice(0, CONFIG.MAX_BATCH) };
      }
      return { token: s.auth.token, session_id: s.session.sessionId, inflight: s.inflight };
    });
    if (!plan) return;

    // (b) The network call. Outside the queue, so new events keep being recorded meanwhile.
    const res = await apiPost("/api/events", {
      batch_id: plan.inflight.batch_id,
      session_id: plan.session_id,
      events: plan.inflight.events
    }, plan.token);

    // (c) Record the outcome. Short, inside the queue.
    const keepGoing = await mutate(async (s) => {
      // Saved, or the server says it already had this batch: either way it is safe.
      if (res.ok || res.code === "DUPLICATE_BATCH") {
        s.inflight = null; s.retryCount = 0; s.nextRetryAt = 0;
        s.lastFlushAt = Date.now(); s.lastError = null;
        return true;
      }
      // Login problem: keep the data, wait for the student to log in again.
      if (res.status === 401 || res.code === "TOKEN_EXPIRED" || res.code === "INVALID_TOKEN") {
        await chrome.storage.local.set({ authExpired: true });
        s.lastError = "Login expired. Open HonorCode and log in again.";
        return false;
      }
      // Server permanently rejected this batch (bad data): retrying can never
      // work, so drop it instead of retrying forever.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        s.inflight = null;
        s.lastError = `Server rejected a batch (${res.code}).`;
        return true;
      }
      // Network failure, timeout, 429 or 5xx: keep the batch and retry later with a growing delay.
      s.retryCount += 1;
      const wait = CONFIG.BACKOFF_MS[Math.min(s.retryCount - 1, CONFIG.BACKOFF_MS.length - 1)];
      s.nextRetryAt = Date.now() + wait;
      s.lastError = "Upload failed, retrying automatically.";
      return false;
    });
    if (!keepGoing) return;
  }
}

// When a session is stopping and everything is uploaded, tell the server it ended.
async function finalizeSession() {
  const plan = await mutate(async (s) => {
    if (s.state !== "flushing" || !s.pendingEnd || !s.session) return null;
    if (s.buffer.length > 0 || s.inflight) return null;              // events still waiting
    if (s.authExpired || Date.now() < s.nextRetryAt) return null;
    return {
      token: s.auth.token,
      body: {
        session_id: s.session.sessionId,
        end_reason: s.pendingEnd.end_reason,
        ended_at: s.pendingEnd.ended_at,
        last_seq: s.seq
      }
    };
  });
  if (!plan) return;

  const res = await apiPost("/api/session/end", plan.body, plan.token);

  await mutate(async (s) => {
    const retryable = res.network || res.status >= 500 || res.status === 429 || res.status === 408;
    if (res.status === 401) {
      await chrome.storage.local.set({ authExpired: true });
      s.lastError = "Login expired. Open HonorCode and log in again.";
    } else if (!res.ok && retryable) {
      s.retryCount += 1;
      s.nextRetryAt = Date.now() + CONFIG.BACKOFF_MS[Math.min(s.retryCount - 1, CONFIG.BACKOFF_MS.length - 1)];
      s.lastError = "Could not close the session, retrying automatically.";
    } else {
      // Success (or a permanent rejection we cannot fix): return to a clean idle state.
      Object.assign(s, {
        ...DEFAULTS,
        lastError: res.ok ? null : `Session end rejected (${res.code}).`
      });
    }
  });
}

// =====================================================================
// 7. HEARTBEAT TIMER
// chrome.alarms is the only timer that survives the worker sleeping.
// Each tick: record a heartbeat, enforce the max duration, and retry any
// pending upload. This is also the "backstop" so nothing sits unsent for long.
// =====================================================================

// Creates the repeating alarm if it does not exist yet.
async function ensureAlarm() {
  const existing = await chrome.alarms.get("tick");
  if (!existing) chrome.alarms.create("tick", { periodInMinutes: CONFIG.HEARTBEAT_MINUTES });
}
ensureAlarm(); // runs every time the worker wakes up

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "tick") return;
  await withState(async (s, add, now) => {
    if (s.state !== "monitoring") return;
    // Safety: a session left running for too long is closed automatically.
    if (s.session && now - s.session.startedAtMs > CONFIG.MAX_SESSION_MS) {
      beginStop(s, add, "timeout", now);
      return;
    }
    add("heartbeat"); // gaps in heartbeats later reveal a disabled extension or closed browser
  }, { always: true });
  syncNow(); // always try to upload on a tick (also retries a stalled upload)
});

// =====================================================================
// 8. BROWSER STARTUP / INSTALL
// =====================================================================

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); });

// The browser was closed and reopened while a session was running.
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  withState(async (s, add) => {
    // Tab ids change after a restart, so look for the quiz tab by its address.
    const tabs = await chrome.tabs.query({});
    const quiz = tabs.find((t) => (t.url || "").startsWith(s.session.quizPrefix));
    s.quizTabId = quiz ? quiz.id : null;
    s.away = null;
    s.unfocusedSince = null;
    add("resumed", { detail: quiz ? "quiz_tab_found" : "quiz_tab_missing" }, true);
  });
});

// =====================================================================
// 9. MESSAGES FROM THE POPUP
// The popup cannot run this logic itself (it closes when you click away),
// so it sends a message and this worker does the work.
// =====================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return; // only accept messages from this extension

  let job;
  if (msg.type === "START") job = startMonitoring(msg.tab);
  else if (msg.type === "STOP") job = stopMonitoring();
  else if (msg.type === "SYNC") { syncNow(); job = Promise.resolve({ ok: true }); } // after re-login
  else return;

  job.then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // tells Chrome the reply will arrive asynchronously
});

// =====================================================================
// 10. TOOLBAR BADGE (the visible "monitoring is active" indicator)
// =====================================================================

function updateBadge(s) {
  let text = "";
  let color = "#555555";
  if (s.state === "monitoring") { text = "REC"; color = "#C62828"; }   // red: tracking is on
  if (s.state === "flushing")   { text = "UP";  color = "#EF6C00"; }   // orange: uploading
  if (s.state !== "idle" && s.lastError) { text = "!"; color = "#EF6C00"; } // problem needing attention
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}
