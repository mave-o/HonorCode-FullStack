// lib/http.js
// Everything shared by all endpoints: error type, CORS, JSON replies,
// the route() wrapper, and a small best-effort rate limiter.

// An error that carries the HTTP status and the code the extension reads.
export class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;   // e.g. 400, 401, 503
    this.code = code;       // e.g. "INVALID_BATCH"
    this.headers = headers; // e.g. { "Retry-After": "5" }
  }
}

// Sends a JSON reply. Every body has ok:true/false, as the extension expects.
export function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

// The error format agreed in the spec: { ok:false, error:{ code, message } }.
export function fail(res, status, code, message, headers = {}) {
  send(res, status, { ok: false, error: { code, message } }, headers);
}

// Allows browsers to call the API from origins listed in ALLOWED_ORIGINS.
// (An extension that has host_permissions does not need this, but QA tools may.)
function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}

// Vercel parses JSON bodies for us; this also copes with a string body.
function readBody(req) {
  const b = req.body;
  if (b === undefined || b === null || b === "") return {};
  if (typeof b === "string") {
    try { return JSON.parse(b); } catch { throw new HttpError(400, "INVALID_JSON", "Request body is not valid JSON."); }
  }
  return b;
}

// Wraps an endpoint: CORS, preflight, method check, body parsing, and one
// place that turns any thrown error into a clean JSON reply.
//   methods : allowed HTTP methods, e.g. ["POST"]
//   fn      : async (req, res, body) => { ... }  (it should call send())
export function route(methods, fn) {
  return async function handler(req, res) {
    try {
      // Imported lazily so a misconfigured env still returns a JSON error.
      const { env } = await import("./env.js");
      applyCors(req, res, safeOrigins(env));
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");

      if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); } // CORS preflight
      if (!methods.includes(req.method)) {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", `Use ${methods.join(" or ")}.`, { Allow: methods.join(", ") });
      }
      await fn(req, res, req.method === "GET" ? {} : readBody(req));
    } catch (e) {
      if (e instanceof HttpError && e.code === "SERVER_MISCONFIGURED") {
        console.error("[honorcode] configuration problem:", e.message); // details go to the Vercel logs only
        return fail(res, 500, "SERVER_MISCONFIGURED", "The server is not configured correctly.");
      }
      if (e instanceof HttpError) return fail(res, e.status, e.code, e.message, e.headers);
      console.error("[honorcode] unhandled error:", e && e.message); // message only: never log bodies or tokens
      return fail(res, 500, "INTERNAL", "Something went wrong on the server.");
    }
  };
}

// CORS must not break the health check if env is misconfigured.
function safeOrigins(env) {
  try { return env().allowedOrigins; } catch { return []; }
}

// The client's IP, as Vercel reports it.
export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (fwd ? String(fwd).split(",")[0].trim() : (req.socket && req.socket.remoteAddress)) || "unknown";
}

// ---- Best-effort rate limiter ----
// Serverless instances do not share memory, so this only slows down attackers
// who hit the same warm instance. For real protection, enable Vercel's firewall rate limiting.
const buckets = new Map(); // key -> { count, resetAt }

// Throws 429 if `key` already hit `max` failures inside the window.
export function checkLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (b && b.resetAt > now && b.count >= max) {
    const wait = Math.ceil((b.resetAt - now) / 1000);
    throw new HttpError(429, "RATE_LIMITED", "Too many attempts. Try again later.", { "Retry-After": String(wait) });
  }
}

// Counts one failure against `key`.
export function recordFailure(key, windowMs) {
  const now = Date.now();
  if (buckets.size > 2000) { // keep memory bounded
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) buckets.set(key, { count: 1, resetAt: now + windowMs });
  else b.count += 1;
}

// Forgets failures after a success.
export function clearLimit(key) {
  buckets.delete(key);
}
