// POST /api/register   { email, name, password, course_code }
// Creates a student account. The course code stops strangers from joining.
// Cost: 1 sheet read + 1 sheet write.

import { timingSafeEqual, randomUUID } from "node:crypto";
import { route, send, HttpError, clientIp, checkLimit, recordFailure } from "../lib/http.js";
import { env } from "../lib/env.js";
import { email, text, password } from "../lib/validate.js";
import { hashPassword } from "../lib/auth.js";
import { emailExists, createAccount } from "../lib/db.js";

const WINDOW_MS = 10 * 60 * 1000;

// Compares two strings without revealing, through timing, how much matched.
function sameText(a, b) {
  const x = Buffer.from(a.toLowerCase()), y = Buffer.from(b.toLowerCase());
  return x.length === y.length && timingSafeEqual(x, y);
}

export default route(["POST"], async (req, res, body) => {
  const cfg = env();
  const limitKey = `register|${clientIp(req)}`;
  checkLimit(limitKey, 10, WINDOW_MS); // at most 10 failed attempts per IP per 10 minutes

  // 1. Check the input.
  const addr = email(body.email);
  const name = text(body.name, "name", 1, 100);
  const pass = password(body.password);
  const code = text(body.course_code, "course_code", 1, 100);

  // 2. Check the course code.
  if (!sameText(code, cfg.courseCode)) {
    recordFailure(limitKey, WINDOW_MS);
    throw new HttpError(403, "INVALID_COURSE_CODE", "That course code is not correct.");
  }

  // 3. Emails must be unique.
  if (await emailExists(addr)) {
    throw new HttpError(409, "EMAIL_TAKEN", "An account with this email already exists.");
  }

  // 4. Save the account. Only the password HASH is stored, never the password.
  await createAccount({
    student_id: "stu_" + randomUUID().slice(0, 8),
    email: addr,
    name,
    course: cfg.courseName,
    password_hash: await hashPassword(pass),
    role: "student", // teachers are set by hand in the sheet
    created_at: new Date().toISOString()
  });

  send(res, 201, { ok: true });
});
