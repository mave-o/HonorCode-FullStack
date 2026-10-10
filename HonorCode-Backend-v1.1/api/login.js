// POST /api/login   { email, password }
// Returns { ok, token, student:{ student_id, email, name, role } }.
// Cost: 1 sheet read (0 if this account was seen recently on this instance).

import { route, send, HttpError, clientIp, checkLimit, recordFailure, clearLimit } from "../lib/http.js";
import { email } from "../lib/validate.js";
import { checkPassword, burnTime, signToken } from "../lib/auth.js";
import { findAccountByEmail } from "../lib/db.js";

const WINDOW_MS = 10 * 60 * 1000;

export default route(["POST"], async (req, res, body) => {
  const addr = email(body.email);
  if (typeof body.password !== "string" || body.password.length === 0 || body.password.length > 72) {
    throw new HttpError(400, "INVALID_REQUEST", "password is required.");
  }

  // Slow down guessing: 5 failures per email+IP per 10 minutes (best effort, see http.js).
  const limitKey = `login|${clientIp(req)}|${addr}`;
  checkLimit(limitKey, 5, WINDOW_MS);

  const account = await findAccountByEmail(addr);
  const ok = account
    ? await checkPassword(body.password, account.password_hash)
    : (await burnTime(body.password), false); // same time cost whether or not the account exists

  if (!ok) {
    recordFailure(limitKey, WINDOW_MS);
    // One message for both "no such email" and "wrong password" (does not reveal which).
    throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
  }

  clearLimit(limitKey);
  const { token, expiresInSeconds } = signToken(account);
  send(res, 200, {
    ok: true,
    token,
    expires_in: expiresInSeconds,
    student: { student_id: account.student_id, email: account.email, name: account.name, role: account.role }
  });
});
