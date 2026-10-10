// POST /api/session/end   { session_id, end_reason, ended_at, last_seq }   (login token required)
// Marks a session finished. Safe to call twice (the second call changes nothing).
// Cost: 1 sheet read + 1 sheet write, once per session.

import { route, send, HttpError } from "../../lib/http.js";
import { requireAuth, sessionBelongsTo } from "../../lib/auth.js";
import { isoDate, integer, END_REASONS } from "../../lib/validate.js";
import { findSession, endSession } from "../../lib/db.js";

export default route(["POST"], async (req, res, body) => {
  const auth = requireAuth(req);

  if (!sessionBelongsTo(body.session_id, auth.studentId)) {
    throw new HttpError(403, "INVALID_SESSION", "This session does not belong to your account.");
  }
  if (!END_REASONS.includes(body.end_reason)) {
    throw new HttpError(400, "INVALID_REQUEST", `end_reason must be one of: ${END_REASONS.join(", ")}.`);
  }
  const endedAt = isoDate(body.ended_at, "ended_at");
  const lastSeq = integer(body.last_seq, "last_seq", 0, 10_000_000);

  const found = await findSession(body.session_id);
  if (!found) throw new HttpError(404, "SESSION_NOT_FOUND", "No such session.");

  // Already ended? Report success without changing anything (makes retries harmless).
  if (found.session.ended_at) return send(res, 200, { ok: true, already_ended: true });

  await endSession(found.rowNumber, { ended_at: endedAt, end_reason: body.end_reason, last_seq: lastSeq });
  send(res, 200, { ok: true });
});
