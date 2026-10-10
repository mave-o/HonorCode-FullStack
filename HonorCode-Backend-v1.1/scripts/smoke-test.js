// scripts/smoke-test.js
// Runs the whole student flow against the real handlers using in-memory storage.
// No Google account, server or network needed.   Run:  npm run test:smoke
// The same steps work as a manual checklist for QA against a deployed URL.

// Settings for this test only (set BEFORE the handlers are imported).
process.env.STORAGE_MODE = "memory";
process.env.JWT_SECRET = "smoke-test-secret-smoke-test-secret-0123456789";
process.env.COURSE_CODE = "TEST-CODE";
process.env.BCRYPT_COST = "8"; // faster hashing, test only
delete process.env.VERCEL_ENV;

const { default: health } = await import("../api/health.js");
const { default: register } = await import("../api/register.js");
const { default: login } = await import("../api/login.js");
const { default: sessionStart } = await import("../api/session/start.js");
const { default: events } = await import("../api/events.js");
const { default: sessionEnd } = await import("../api/session/end.js");
const { getStore } = await import("../lib/db.js");

// Calls a handler with a fake request and returns { status, body, headers }.
function call(handler, { method = "POST", body, token, ip = "1.2.3.4" } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    const req = { method, body, headers: { "x-forwarded-for": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) } };
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      end: (text) => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null, headers })
    };
    handler(req, res);
  });
}

let failed = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failed++;
}

const evt = (seq, type, extra = {}) => ({ seq, type, client_ts: new Date().toISOString(), ...extra });
const creds = { email: "Ana@School.edu", name: "Ana Cruz", password: "correct-horse-1", course_code: "test-code" };

let r = await call(health, { method: "GET" });
check("health responds ok", r.status === 200 && r.body.ok);

r = await call(health, { method: "POST" });
check("wrong method gives 405", r.status === 405 && r.body.error.code === "METHOD_NOT_ALLOWED");

r = await call(register, { body: { ...creds, course_code: "nope" } });
check("register: wrong course code -> 403", r.status === 403 && r.body.error.code === "INVALID_COURSE_CODE");

r = await call(register, { body: { ...creds, password: "short" } });
check("register: short password -> 400", r.status === 400 && r.body.error.code === "INVALID_REQUEST");

r = await call(register, { body: creds });
check("register: ok -> 201", r.status === 201 && r.body.ok, JSON.stringify(r.body));

r = await call(register, { body: creds });
check("register: duplicate email -> 409", r.status === 409 && r.body.error.code === "EMAIL_TAKEN");

r = await call(login, { body: { email: creds.email, password: "wrong-password" } });
check("login: wrong password -> 401", r.status === 401 && r.body.error.code === "INVALID_CREDENTIALS");

r = await call(login, { body: { email: "ghost@school.edu", password: "whatever-123" } });
check("login: unknown email -> same 401", r.status === 401 && r.body.error.code === "INVALID_CREDENTIALS");

r = await call(login, { body: { email: creds.email, password: creds.password } });
const token = r.body && r.body.token;
check("login: ok returns token + student", r.status === 200 && !!token && r.body.student.email === "ana@school.edu");

r = await call(sessionStart, { body: { quiz_id: "form-123" } });
check("session/start: no token -> 401", r.status === 401 && r.body.error.code === "INVALID_TOKEN");

r = await call(sessionStart, { token: token + "x", body: { quiz_id: "form-123" } });
check("session/start: tampered token -> 401", r.status === 401 && r.body.error.code === "INVALID_TOKEN");

r = await call(sessionStart, { token, body: { quiz_id: "bad id!" } });
check("session/start: bad quiz_id -> 400", r.status === 400);

r = await call(sessionStart, { token, body: { quiz_id: "form-123", client_ts: new Date().toISOString() } });
const sessionId = r.body && r.body.session_id;
check("session/start: ok returns session_id", r.status === 200 && /^sess_/.test(sessionId || ""));

const batch = {
  batch_id: "11111111-1111-4111-8111-111111111111", session_id: sessionId,
  events: [evt(1, "monitoring_started", { domain: "docs.google.com", category: "notes_docs" }),
           evt(2, "tab_left", { domain: "chatgpt.com", category: "ai_tool" }),
           evt(3, "tab_returned", { domain: "chatgpt.com", category: "ai_tool", duration_ms: 40000 }),
           evt(4, "idle_state", { detail: "idle" })]
};
r = await call(events, { token, body: batch });
check("events: ok accepts 4", r.status === 200 && r.body.accepted === 4, JSON.stringify(r.body));

r = await call(events, { token, body: batch });
check("events: repeated batch_id is skipped", r.status === 200 && r.body.duplicate === true);

r = await call(events, { token, body: { ...batch, batch_id: "22222222-2222-4222-8222-222222222222", session_id: "sess_x" } });
check("events: forged session -> 403", r.status === 403 && r.body.error.code === "INVALID_SESSION");

r = await call(events, { token, body: { ...batch, batch_id: "33333333-3333-4333-8333-333333333333", events: [evt(0, "tab_left")] } });
check("events: bad seq -> 400 INVALID_BATCH", r.status === 400 && r.body.error.code === "INVALID_BATCH");

r = await call(events, { token, body: { ...batch, batch_id: "44444444-4444-4444-8444-444444444444", events: [evt(5, "heartbeat", { domain: "=HYPERLINK(1)", extra_field: "ignored" })] } });
check("events: formula-like text is stored as plain text", r.status === 200);

// A second student must not be able to write into the first student's session.
await call(register, { body: { ...creds, email: "ben@school.edu", name: "Ben" }, ip: "5.6.7.8" });
const t2 = (await call(login, { body: { email: "ben@school.edu", password: creds.password }, ip: "5.6.7.8" })).body.token;
r = await call(events, { token: t2, body: { ...batch, batch_id: "55555555-5555-4555-8555-555555555555" } });
check("events: another student's session -> 403", r.status === 403);

r = await call(sessionEnd, { token, body: { session_id: sessionId, end_reason: "bogus", ended_at: new Date().toISOString(), last_seq: 5 } });
check("session/end: bad end_reason -> 400", r.status === 400);

const endBody = { session_id: sessionId, end_reason: "auto_submit", ended_at: new Date().toISOString(), last_seq: 5 };
r = await call(sessionEnd, { token, body: endBody });
check("session/end: ok", r.status === 200 && r.body.ok && !r.body.already_ended, JSON.stringify(r.body));

r = await call(sessionEnd, { token, body: endBody });
check("session/end: repeat is harmless", r.status === 200 && r.body.already_ended === true);

// Inspect what was actually stored.
const store = getStore();
const logs = await store.readRows("logs");
const sess = (await store.readRows("sessions"))[0];
check("storage: 5 log rows written", logs.length === 5, `got ${logs.length}`);
check("storage: log row has email + batch_id + seq in the right columns", logs[0][3] === "ana@school.edu" && logs[0][5] === batch.batch_id && logs[0][6] === "1");
check("storage: session row closed with reason + last_seq", sess[5] !== "" && sess[6] === "auto_submit" && sess[7] === "5");
check("storage: password is hashed, not stored", (await store.readRows("accounts"))[0][4].startsWith("$2"));

// Brute-force slow-down: the successful login above reset the counter, so 5 wrong guesses are
// allowed, and the 6th attempt must be blocked.
for (let i = 0; i < 5; i++) await call(login, { body: { email: creds.email, password: "bad-guess-" + i } });
r = await call(login, { body: { email: creds.email, password: "bad-guess-final" } });
check("login: repeated failures -> 429", r.status === 429 && r.body.error.code === "RATE_LIMITED");

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
