// lib/validate.js
// Checks every value that arrives from the client. The client is never trusted:
// anything not on these lists is rejected, trimmed, or ignored.

import { HttpError } from "./http.js";

// Removes control characters (line breaks, tabs, etc.) from text.
const clean = (s) => s.replace(/[\u0000-\u001f\u007f]/g, "").trim();

function bad(code, msg) { return new HttpError(400, code, msg); }

// A required text value with length limits.
export function text(v, name, min, max, code = "INVALID_REQUEST") {
  if (typeof v !== "string") throw bad(code, `${name} must be text.`);
  const s = clean(v);
  if (s.length < min || s.length > max) throw bad(code, `${name} must be ${min}-${max} characters.`);
  return s;
}

// A valid, lower-cased email address.
export function email(v) {
  const s = text(v, "email", 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad("INVALID_REQUEST", "email is not valid.");
  return s;
}

// A password. 72 is bcrypt's real limit; longer ones would be silently cut.
export function password(v) {
  if (typeof v !== "string" || v.length < 8 || v.length > 72) {
    throw bad("INVALID_REQUEST", "password must be 8-72 characters.");
  }
  return v;
}

// A date/time string the server can parse; returned in a standard form.
export function isoDate(v, name, code = "INVALID_REQUEST") {
  if (typeof v !== "string") throw bad(code, `${name} must be a date string.`);
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t < Date.UTC(2020, 0, 1) || t > Date.UTC(2100, 0, 1)) {
    throw bad(code, `${name} is not a valid date.`);
  }
  return new Date(t).toISOString();
}

// A whole number inside a range.
export function integer(v, name, min, max, code = "INVALID_REQUEST") {
  if (!Number.isInteger(v) || v < min || v > max) throw bad(code, `${name} must be a whole number ${min}-${max}.`);
  return v;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const END_REASONS = ["manual", "auto_submit", "timeout", "none"];
const WORD = /^[a-z][a-z0-9_]{0,39}$/; // event types and categories, e.g. "tab_left", "ai_tool"
export const MAX_EVENTS_PER_BATCH = 50;  // must match MAX_BATCH in the extension's config.js

// Validates the quiz id sent when a session starts.
export function quizId(v) {
  const s = text(v, "quiz_id", 1, 200);
  if (!/^[\w.:-]+$/.test(s)) throw bad("INVALID_REQUEST", "quiz_id has unsupported characters.");
  return s;
}

// Validates one batch of events. Returns a clean array containing ONLY the known fields.
// Any problem rejects the whole batch with INVALID_BATCH (the extension then drops it).
export function eventBatch(body) {
  if (!body || typeof body.batch_id !== "string" || !UUID.test(body.batch_id)) {
    throw bad("INVALID_BATCH", "batch_id must be a UUID.");
  }
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > MAX_EVENTS_PER_BATCH) {
    throw bad("INVALID_BATCH", `events must hold 1-${MAX_EVENTS_PER_BATCH} items.`);
  }

  const events = body.events.map((e, i) => {
    const at = `events[${i}]`;
    if (!e || typeof e !== "object") throw bad("INVALID_BATCH", `${at} must be an object.`);
    if (typeof e.type !== "string" || !WORD.test(e.type)) throw bad("INVALID_BATCH", `${at}.type is not valid.`);

    const out = {
      seq: integer(e.seq, `${at}.seq`, 1, 10_000_000, "INVALID_BATCH"),
      type: e.type,
      client_ts: isoDate(e.client_ts, `${at}.client_ts`, "INVALID_BATCH"),
      domain: null, category: null, duration_ms: null, detail: null
    };
    // Optional fields: null/undefined are fine, anything else must pass its check.
    if (e.domain != null) out.domain = text(e.domain, `${at}.domain`, 1, 253, "INVALID_BATCH");
    if (e.category != null) {
      if (typeof e.category !== "string" || !WORD.test(e.category)) throw bad("INVALID_BATCH", `${at}.category is not valid.`);
      out.category = e.category;
    }
    if (e.duration_ms != null) out.duration_ms = integer(e.duration_ms, `${at}.duration_ms`, 0, 7 * 24 * 3600 * 1000, "INVALID_BATCH");
    if (e.detail != null) out.detail = text(e.detail, `${at}.detail`, 1, 100, "INVALID_BATCH");
    return out;
  });

  return { batchId: body.batch_id.toLowerCase(), events };
}
