# HonorCode backend

Vercel serverless API (Node.js 22, ES modules) that stores quiz-session activity in a Google Sheet.
It implements exactly what the HonorCode extension calls. Nothing else.

## Folder map

```
api/                    each file here becomes a URL (Vercel routes these)
  health.js             GET  /api/health
  register.js           POST /api/register
  login.js              POST /api/login
  events.js             POST /api/events
  session/start.js      POST /api/session/start
  session/end.js        POST /api/session/end
lib/                    shared code (NOT routed, so it is not a public URL)
  env.js                reads + validates environment variables
  http.js               error type, CORS, JSON replies, rate limiter, route() wrapper
  auth.js               bcrypt, login tokens (JWT), signed session ids
  validate.js           checks every client-supplied value
  db-schema.js          the sheet tabs and column ORDER (single source of truth)
  db.js                 named data functions the endpoints call
  sheets.js             Google Sheets REST client (one request per function)
  memory.js             in-memory stand-in for local testing
scripts/
  setup-sheet.js        creates tabs + headers in your sheet (npm run setup:sheet)
  smoke-test.js         runs the full student flow with no Google account (npm run test:smoke)
```

## Setup

### 1. Google Sheet and service account

1. In Google Cloud Console create a project, then **enable the Google Sheets API**.
2. Create a **service account** (IAM & Admin > Service Accounts), then add a **JSON key** and download it.
3. Create an empty Google Sheet. Copy its ID from the address bar.
4. **Share the sheet with the service account's `client_email` as Editor.**
5. Keep the JSON key out of the repo (`.gitignore` blocks common names, but be careful).

### 2. Run locally

```
npm install
cp .env.example .env        # then fill it in (see comments inside)
npm run setup:sheet         # creates the accounts / sessions / logs tabs + headers
npm run test:smoke          # no Google needed; checks all endpoints and the stored data
npx vercel dev              # serves http://localhost:3000, which the extension's .env already points to
```

To try the API with no Google account at all, set `STORAGE_MODE=memory` in `.env`.

### 3. Deploy to Vercel

1. Push this folder to GitHub (if it sits inside a monorepo, set **Root Directory** in Vercel to this folder).
2. Import the repo in Vercel. No build settings are needed; it detects the `api/` folder.
3. Under **Settings > Environment Variables** add every name from `.env.example`
   (`STORAGE_MODE=sheets`, `GOOGLE_*`, `JWT_SECRET`, `COURSE_CODE`, ...). Mark the key and secret as Sensitive.
4. Deploy, then open `https://<project>.vercel.app/api/health`. You want `"ok":true,"configured":true`.
   If `configured` is false, the Vercel function logs say which variable is wrong.
5. Point the extension at it: in the extension's `.env` set `API_BASE_URL=https://<project>.vercel.app`,
   run `node scripts/build-env.js`, and reload the extension.

Use the **production domain** (`<project>.vercel.app` or a custom domain). Vercel's default Deployment
Protection can block the generated per-deployment and preview URLs with a login page; the extension would
see that as a 401 and think the student's login expired.

## API contract (matches the extension)

Every reply is JSON. Success has `"ok": true`. Errors are `{ "ok": false, "error": { "code", "message" } }`.

| Endpoint | Auth | Request | Success reply |
|---|---|---|---|
| `GET /api/health` | no | | `{ok, service, configured, time}` |
| `POST /api/register` | no | `{email, name, password, course_code}` | 201 `{ok}` |
| `POST /api/login` | no | `{email, password}` | `{ok, token, expires_in, student:{student_id,email,name,role}}` |
| `POST /api/session/start` | Bearer | `{quiz_id, client_ts}` | `{ok, session_id, started_at}` |
| `POST /api/events` | Bearer | `{batch_id, session_id, events:[1-50]}` | `{ok, accepted}` or `{ok, duplicate:true}` |
| `POST /api/session/end` | Bearer | `{session_id, end_reason, ended_at, last_seq}` | `{ok}` or `{ok, already_ended:true}` |

Event fields: `seq` (int >= 1), `type` (lowercase word), `client_ts` (ISO date), and optional
`domain`, `category`, `duration_ms`, `detail`. Unknown fields are ignored.

### Error codes and what the extension does with them

| Status | Code | Extension behaviour |
|---|---|---|
| 401 | `INVALID_TOKEN`, `TOKEN_EXPIRED` | Keeps its data, asks the student to log in again, then resumes |
| 400 | `INVALID_BATCH` | Drops that batch (retrying could never succeed) |
| 403 | `INVALID_SESSION`, `INVALID_COURSE_CODE` | Batch dropped / message shown |
| 404 | `SESSION_NOT_FOUND` | Session closes locally |
| 409 | `EMAIL_TAKEN` | Message shown in the popup |
| 429 | `RATE_LIMITED` | Retries later (login shows the message) |
| 503 | `STORAGE_UNAVAILABLE` | Keeps the batch and retries with backoff |
| 500 | `INTERNAL`, `SERVER_MISCONFIGURED` | Keeps the batch and retries |

## Sheet layout (column ORDER matters; the backend writes by position)

| Tab | Columns |
|---|---|
| `accounts` | student_id, email, name, course, password_hash, role, created_at |
| `sessions` | session_id, student_id, email, quiz_id, started_at, ended_at, end_reason, last_seq |
| `logs` | server_ts, client_ts, student_id, email, session_id, batch_id, seq, event_type, domain, category, duration_ms, detail |

Differences from the earlier draft spec: `logs` gained `email`, `duration_ms`, `detail`; `sessions` gained `email`
and `last_seq`. Update the shared spec to match. **Make a teacher** by changing a row's `role` to `teacher` by hand
(nothing in the API uses it yet). Use `server_ts`, not `client_ts`, as the trusted time.
A session is **incomplete** when its `ended_at` is blank. `last_seq` vs the highest `seq` in `logs` reveals missing events.

## Limits you must know about

- **Google Sheets quota: 60 writes and 60 reads per minute for the whole service account**
  (Google's published limit; a service account counts as one user). Each upload batch is one write.
  The extension uploads at least once per heartbeat (default 30 s), so each active student costs about
  2 writes/min or more. That is roughly **25 simultaneous students at the defaults**, and about 45 if you set
  `HEARTBEAT_MINUTES=1` in the extension's `.env`. When the quota is exceeded the API answers 503 and the
  extension retries, so data is delayed, not lost. Treat these numbers as estimates and have QA run a load test.
  You can request a higher quota in Google Cloud, or move to a real database (the `lib/db.js` layer is the only code to change).
  If you raise the heartbeat interval, raise the "extension may be disabled" gap threshold above it.
- **Duplicate protection is best effort.** Repeated batches are skipped only if they reach the same warm instance.
  A duplicate on another instance writes the rows again, but each row has `batch_id` and `seq`, so duplicates are
  identifiable (same `session_id` + `seq`).
- **Two people registering the same email at the same instant** can both succeed (Sheets has no unique constraint).
- **Rate limiting is best effort** (per instance). For real protection add a Vercel Firewall rate-limit rule on `/api/login` and `/api/register`.
- **Tokens are not revocable** before they expire (`JWT_EXPIRY_HOURS`). Rotate `JWT_SECRET` to log everyone out.
- **No password reset yet.** Fix a forgotten password by deleting the account row so the student can register again.
- **Sheet access = data access.** Anyone who can open the sheet sees activity logs and name/email. Restrict sharing.

## Security notes

- Passwords are stored only as bcrypt hashes. Login gives the same reply for "no such email" and "wrong password".
- Values are written to Sheets as RAW text, so something like `=IMPORTXML(...)` from a client is never run as a formula.
  If you export to Excel or CSV later, check for cells beginning with `=`, `+`, `-` or `@`.
- Only whitelisted fields are copied from requests; lengths and formats are checked on every one.
- A session id carries a signature tied to one student, so `/api/events` rejects other students' sessions without reading the sheet.
- Logs never contain request bodies, passwords or tokens.
- Treat the recorded data as personal data: tell students what is collected, keep retention short, and delete old rows.

## Handy commands

```
npm run test:smoke      full flow, in memory, no network
npm run setup:sheet     create/verify sheet tabs and headers
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # make a JWT_SECRET
```
