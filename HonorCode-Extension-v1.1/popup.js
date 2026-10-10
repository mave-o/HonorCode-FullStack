// popup.js
// Controls the toolbar popup: login/register, Start, Stop and live status.
// The popup closes whenever you click away, so it keeps NO state of its own.
// It reads everything from chrome.storage.local (written by background.js)
// and redraws whenever that storage changes.

import { apiPost } from "./api.js";
import { CONFIG } from "./config.js";

// Shortcut for document.getElementById.
const $ = (id) => document.getElementById(id);

let mode = "login";   // whether the auth form is in "login" or "register" mode
let latest = null;    // the most recent stored state, used by the elapsed-time clock

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

// Shows (or clears) the red error line.
function showError(msg) {
  const el = $("error");
  el.textContent = msg || "";
  el.hidden = !msg;
}

// Disables a button while an async action runs, so it cannot be double-clicked.
async function withBusy(button, fn) {
  button.disabled = true;
  try { await fn(); } finally { button.disabled = false; }
}

// Formats milliseconds as m:ss for the elapsed-time display.
function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------
// Drawing the popup from stored state
// ---------------------------------------------------------------------

async function render() {
  // Read everything the popup needs. The defaults apply on first run.
  const s = await chrome.storage.local.get({
    auth: null, authExpired: false, state: "idle", session: null,
    buffer: [], inflight: null, lastError: null
  });
  latest = s;

  // Which of the three views to show.
  const needsLogin = !s.auth || s.authExpired;
  $("view-auth").hidden = !needsLogin;
  $("view-home").hidden = needsLogin || s.state !== "idle";
  $("view-active").hidden = needsLogin || s.state === "idle";
  $("auth-note").hidden = !(s.auth && s.authExpired);

  // Status pill in the header.
  const pill = $("pill");
  pill.className = "pill" + (s.state === "monitoring" ? " on" : s.state === "flushing" ? " up" : "");
  pill.textContent = s.state === "monitoring" ? "Tracking on" : s.state === "flushing" ? "Uploading" : "Off";

  // Home view: who is logged in.
  if (s.auth) $("who").textContent = s.auth.name || s.auth.email;

  // Active view: status line, upload queue, and the Stop button.
  if (s.state !== "idle") {
    $("active-status").textContent =
      s.state === "monitoring" ? "Tracking is ON"
      : s.lastError ? "Upload failed. Retrying automatically..."
      : "Uploading your session...";

    // How many events are still waiting to reach the server.
    const waiting = s.buffer.length + (s.inflight ? s.inflight.events.length : 0);
    $("queue").textContent = `Events waiting to upload: ${waiting}`;

    // Stop is only offered while tracking is on, and only if the config allows it.
    $("btn-stop").hidden = !CONFIG.ALLOW_MANUAL_STOP || s.state !== "monitoring";
    $("auto-note").hidden = CONFIG.ALLOW_MANUAL_STOP;
  }

  // Show the stored problem text, if any (e.g. "Login expired").
  if (s.lastError && s.state !== "idle") showError(s.lastError);
  renderTimer();
}

// Updates the elapsed-time line; also called once per second.
function renderTimer() {
  if (latest && latest.state === "monitoring" && latest.session) {
    $("timer").textContent = "Elapsed: " + formatElapsed(Date.now() - latest.session.startedAtMs);
  } else {
    $("timer").textContent = "";
  }
}
setInterval(renderTimer, 1000);

// Redraw whenever background.js (or this popup) changes storage.
chrome.storage.onChanged.addListener(render);
render();

// ---------------------------------------------------------------------
// Login / Register
// ---------------------------------------------------------------------

// Switches the form between the two modes by showing or hiding fields.
function setMode(newMode) {
  mode = newMode;
  const reg = mode === "register";
  $("tab-login").classList.toggle("active", !reg);
  $("tab-register").classList.toggle("active", reg);
  $("row-name").hidden = !reg;
  $("row-code").hidden = !reg;
  $("btn-auth").textContent = reg ? "Create account" : "Log in";
  $("password").autocomplete = reg ? "new-password" : "current-password";
  showError("");
}
$("tab-login").addEventListener("click", () => setMode("login"));
$("tab-register").addEventListener("click", () => setMode("register"));

$("btn-auth").addEventListener("click", () => withBusy($("btn-auth"), async () => {
  showError("");
  const email = $("email").value.trim().toLowerCase();
  const password = $("password").value;

  // Basic checks so obviously empty forms never reach the server.
  if (!email || !password) return showError("Enter your email and password.");

  // Registration first creates the account, then falls through to log in.
  if (mode === "register") {
    const name = $("name").value.trim();
    const courseCode = $("course-code").value.trim();
    if (!name || !courseCode) return showError("Enter your name and the course code.");
    const reg = await apiPost("/api/register", { email, name, password, course_code: courseCode });
    if (!reg.ok) return showError(reg.message);
  }

  const login = await apiPost("/api/login", { email, password });
  if (!login.ok) return showError(login.message);

  // Save the login. The password itself is never stored, only the token.
  const { token, student } = login.data;
  await chrome.storage.local.set({
    auth: { token, studentId: student.student_id, email: student.email, name: student.name },
    authExpired: false
  });
  $("password").value = "";
  chrome.runtime.sendMessage({ type: "SYNC" }); // resume any upload that was waiting for a fresh login
}));

// Logging out is only possible while tracking is off.
$("btn-logout").addEventListener("click", async () => {
  await chrome.storage.local.remove("auth");
});

// ---------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------

$("btn-start").addEventListener("click", () => withBusy($("btn-start"), async () => {
  showError("");
  if (!$("consent").checked) return showError("Tick the box to confirm you understand what is recorded.");

  // The tab that is open right now is treated as the quiz tab.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await chrome.runtime.sendMessage({ type: "START", tab: { id: tab.id, url: tab.url } });
  if (!res || !res.ok) showError((res && res.error) || "Could not start tracking.");
}));

$("btn-stop").addEventListener("click", () => withBusy($("btn-stop"), async () => {
  showError("");
  const res = await chrome.runtime.sendMessage({ type: "STOP" });
  if (!res || !res.ok) showError((res && res.error) || "Could not stop tracking.");
}));
