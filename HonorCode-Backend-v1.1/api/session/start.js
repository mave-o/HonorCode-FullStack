// POST /api/session/start   { quiz_id, client_ts }   (login token required)
// Creates a session row and returns its signed session_id.
// Cost: 1 sheet write.

import { route, send } from "../../lib/http.js";
import { requireAuth, makeSessionId } from "../../lib/auth.js";
import { quizId, isoDate } from "../../lib/validate.js";
import { createSession } from "../../lib/db.js";

export default route(["POST"], async (req, res, body) => {
  const auth = requireAuth(req);
  const quiz = quizId(body.quiz_id);
  if (body.client_ts !== undefined) isoDate(body.client_ts, "client_ts"); // checked, but the SERVER clock is the one stored

  const sessionId = makeSessionId(auth.studentId);
  const startedAt = new Date().toISOString();

  await createSession({
    session_id: sessionId, student_id: auth.studentId, email: auth.email,
    quiz_id: quiz, started_at: startedAt, ended_at: "", end_reason: "", last_seq: ""
  });

  send(res, 200, { ok: true, session_id: sessionId, started_at: startedAt });
});
