// POST /api/events   { batch_id, session_id, events:[...] }   (login token required)
// Stores a batch of events as rows in the "logs" tab.
// Cost: 1 sheet write and ZERO reads (the session id carries its own proof of ownership).

import { route, send, HttpError } from "../lib/http.js";
import { requireAuth, sessionBelongsTo } from "../lib/auth.js";
import { eventBatch } from "../lib/validate.js";
import { appendLogs } from "../lib/db.js";

// Batches stored recently by THIS instance. If the extension re-sends a batch because
// our reply got lost, we skip it instead of writing the rows twice.
// Best effort: another instance would not know. Every log row also carries batch_id and
// seq, so any duplicate that slips through can be removed later (same session_id + seq).
const seen = new Map(); // batch_id -> time stored
const SEEN_MS = 60 * 60 * 1000;

function remember(id) {
  const now = Date.now();
  if (seen.size > 1000) for (const [k, t] of seen) if (now - t > SEEN_MS) seen.delete(k);
  seen.set(id, now);
}

export default route(["POST"], async (req, res, body) => {
  const auth = requireAuth(req);

  // The session must be one this student started (checked by signature, no sheet read).
  if (!sessionBelongsTo(body.session_id, auth.studentId)) {
    throw new HttpError(403, "INVALID_SESSION", "This session does not belong to your account.");
  }

  const { batchId, events } = eventBatch(body); // throws INVALID_BATCH on any bad field

  if (seen.has(batchId)) {
    return send(res, 200, { ok: true, duplicate: true, accepted: 0 });
  }

  await appendLogs({ serverTs: new Date().toISOString(), auth, sessionId: body.session_id, batchId, events });
  remember(batchId); // only AFTER a successful write, so a failed write can still be retried

  send(res, 200, { ok: true, accepted: events.length });
});
