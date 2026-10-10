// lib/auth.js
// Passwords, login tokens (JWT) and session ids.

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "./env.js";
import { HttpError } from "./http.js";

// ---- Passwords ----
// bcrypt is slow ON PURPOSE, so stolen hashes are hard to crack.
export const hashPassword = (plain) => bcrypt.hash(plain, env().bcryptCost);
export const checkPassword = (plain, hash) => bcrypt.compare(plain, hash);

// When an email is unknown we still run one bcrypt comparison, so the
// response time does not reveal whether an account exists.
let dummy = null;
export async function burnTime(plain) {
  dummy ||= await bcrypt.hash("not-a-real-password", env().bcryptCost);
  await bcrypt.compare(plain, dummy);
}

// ---- Login tokens ----
// The token proves "this is student X". The server verifies it with no database read.
export function signToken(account) {
  const { jwtSecret, jwtExpiryHours } = env();
  const token = jwt.sign(
    { sub: account.student_id, email: account.email, name: account.name, role: account.role },
    jwtSecret,
    { algorithm: "HS256", expiresIn: `${jwtExpiryHours}h` } // algorithm is pinned on purpose
  );
  return { token, expiresInSeconds: jwtExpiryHours * 3600 };
}

// Reads "Authorization: Bearer <token>" and returns who is calling.
// 401 + TOKEN_EXPIRED / INVALID_TOKEN tells the extension to ask for a new login (it keeps its data).
export function requireAuth(req) {
  const header = req.headers.authorization || "";
  const m = header.match(/^Bearer (.+)$/);
  if (!m) throw new HttpError(401, "INVALID_TOKEN", "Missing login token.");
  try {
    const p = jwt.verify(m[1], env().jwtSecret, { algorithms: ["HS256"] });
    return { studentId: p.sub, email: p.email, name: p.name, role: p.role };
  } catch (e) {
    if (e && e.name === "TokenExpiredError") throw new HttpError(401, "TOKEN_EXPIRED", "Login expired. Please log in again.");
    throw new HttpError(401, "INVALID_TOKEN", "Login token is not valid.");
  }
}

// ---- Session ids ----
// A session id is "sess_<uuid>.<signature>". The signature ties it to ONE student,
// so /api/events can check "does this session belong to this person?" with no
// sheet read (important: Google Sheets only allows 60 reads per minute).
const mac = (uuid, studentId) =>
  createHmac("sha256", env().jwtSecret).update(`session|${uuid}|${studentId}`).digest("base64url").slice(0, 22);

export function makeSessionId(studentId) {
  const uuid = randomUUID();
  return `sess_${uuid}.${mac(uuid, studentId)}`;
}

export function sessionBelongsTo(sessionId, studentId) {
  const m = typeof sessionId === "string" && sessionId.match(/^sess_([0-9a-f-]{36})\.([A-Za-z0-9_-]{22})$/);
  if (!m) return false;
  const expected = Buffer.from(mac(m[1], studentId));
  const given = Buffer.from(m[2]);
  return expected.length === given.length && timingSafeEqual(expected, given); // constant-time compare
}
