// lib/db-schema.js
// The ONE place that defines the sheet tabs and their column order.
// The backend writes rows by position, so this order must match the header row in the sheet.
// If you change it, update the spec, the sheet headers, and re-run `npm run setup:sheet`.

export const TABS = {
  accounts: ["student_id", "email", "name", "course", "password_hash", "role", "created_at"],
  sessions: ["session_id", "student_id", "email", "quiz_id", "started_at", "ended_at", "end_reason", "last_seq"],
  logs: ["server_ts", "client_ts", "student_id", "email", "session_id", "batch_id", "seq",
         "event_type", "domain", "category", "duration_ms", "detail"]
};
