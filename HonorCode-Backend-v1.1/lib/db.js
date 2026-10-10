// lib/db.js
// The data layer. Endpoints call these named functions and never touch rows directly.
// It works on top of either sheets.js (real) or memory.js (local testing).

import { env } from "./env.js";
import { TABS } from "./db-schema.js";
import { sheetsStore } from "./sheets.js";
import { memoryStore } from "./memory.js";

// Which storage is active (decided by STORAGE_MODE).
export const getStore = () => (env().storage === "memory" ? memoryStore : sheetsStore);

// Builds a row in the correct column order from a plain object.
const toRow = (tab, obj) => TABS[tab].map((col) => (obj[col] === null || obj[col] === undefined ? "" : obj[col]));
// Builds a plain object from a row.
const fromRow = (tab, row) => Object.fromEntries(TABS[tab].map((col, i) => [col, row[i] ?? ""]));

// ---- Accounts ----

// Accounts that were found recently are remembered, so a classroom logging in at
// the same moment does not use up the 60 reads/minute Google allows. A miss ALWAYS
// re-reads the sheet, so a brand-new account is never "not found" because of the cache.
const cache = new Map(); // email -> { account, at }
const CACHE_MS = 10 * 60 * 1000;

export async function findAccountByEmail(email) {
  const hit = cache.get(email);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.account;

  const rows = await getStore().readRows("accounts");
  const row = rows.find((r) => (r[1] || "").toLowerCase() === email);
  if (!row) return null;
  const account = fromRow("accounts", row);
  if (cache.size > 500) cache.clear();
  cache.set(email, { account, at: Date.now() });
  return account;
}

// Always reads fresh (never the cache): used to keep emails unique.
export async function emailExists(email) {
  const rows = await getStore().readRows("accounts");
  return rows.some((r) => (r[1] || "").toLowerCase() === email);
}

export async function createAccount(account) {
  await getStore().appendRows("accounts", [toRow("accounts", account)]);
}

// ---- Sessions ----

export async function createSession(session) {
  await getStore().appendRows("sessions", [toRow("sessions", session)]);
}

// Finds a session row. Returns { rowNumber, session } or null.
export async function findSession(sessionId) {
  const rows = await getStore().readRows("sessions");
  const i = rows.findIndex((r) => r[0] === sessionId);
  if (i === -1) return null;
  return { rowNumber: i + 2, session: fromRow("sessions", rows[i]) }; // +2: header is row 1, data starts at row 2
}

// Fills in ended_at, end_reason and last_seq (columns 6 to 8).
export async function endSession(rowNumber, { ended_at, end_reason, last_seq }) {
  await getStore().updateCells("sessions", rowNumber, 6, [ended_at, end_reason, last_seq]);
}

// ---- Logs ----

// Writes a whole batch of events as rows, in ONE request.
export async function appendLogs({ serverTs, auth, sessionId, batchId, events }) {
  const rows = events.map((e) => toRow("logs", {
    server_ts: serverTs, client_ts: e.client_ts,
    student_id: auth.studentId, email: auth.email,
    session_id: sessionId, batch_id: batchId, seq: e.seq,
    event_type: e.type, domain: e.domain, category: e.category,
    duration_ms: e.duration_ms, detail: e.detail
  }));
  await getStore().appendRows("logs", rows);
}
