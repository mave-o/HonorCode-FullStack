// lib/env.js
// Reads and checks every environment variable in ONE place.
// On Vercel these come from Project Settings > Environment Variables.
// Locally they come from your .env file. Nothing here is ever sent to the client.

import { HttpError } from "./http.js";

let cached = null; // validated once per warm instance, then reused

// Turns a comma-separated string into a clean list.
function list(v) {
  return (v || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Reads a number with a default and a safe range.
function num(name, fallback, min, max) {
  const raw = process.env[name];
  const v = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    throw new HttpError(500, "SERVER_MISCONFIGURED", `${name} must be a number between ${min} and ${max}.`);
  }
  return v;
}

// Returns the validated settings. Throws a 500 (never leaks the value) if something is wrong.
export function env() {
  if (cached) return cached;

  const storage = (process.env.STORAGE_MODE || "sheets").toLowerCase();
  if (storage !== "sheets" && storage !== "memory") {
    throw new HttpError(500, "SERVER_MISCONFIGURED", "STORAGE_MODE must be 'sheets' or 'memory'.");
  }
  // Memory mode forgets everything when the function restarts, so it must never run in production.
  if (storage === "memory" && process.env.VERCEL_ENV === "production") {
    throw new HttpError(500, "SERVER_MISCONFIGURED", "STORAGE_MODE=memory is not allowed in production.");
  }

  const jwtSecret = process.env.JWT_SECRET || "";
  if (jwtSecret.length < 32) {
    throw new HttpError(500, "SERVER_MISCONFIGURED", "JWT_SECRET must be at least 32 characters.");
  }
  const courseCode = (process.env.COURSE_CODE || "").trim();
  if (!courseCode) {
    throw new HttpError(500, "SERVER_MISCONFIGURED", "COURSE_CODE is required.");
  }

  const cfg = {
    storage,
    jwtSecret,
    jwtExpiryHours: num("JWT_EXPIRY_HOURS", 8, 1, 72),
    bcryptCost: num("BCRYPT_COST", 10, 8, 14),
    courseCode,
    courseName: (process.env.COURSE_NAME || "course-1").trim(),
    allowedOrigins: list(process.env.ALLOWED_ORIGINS),
    sheetId: process.env.GOOGLE_SHEET_ID || "",
    serviceEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
    // The private key often arrives with literal "\n" text instead of real new lines. Fix both cases.
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/^"|"$/g, "").replace(/\\n/g, "\n")
  };

  if (storage === "sheets" && (!cfg.sheetId || !cfg.serviceEmail || !cfg.privateKey)) {
    throw new HttpError(500, "SERVER_MISCONFIGURED",
      "GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY are required when STORAGE_MODE=sheets.");
  }
  cached = cfg;
  return cfg;
}
