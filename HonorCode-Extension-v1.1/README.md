# HonorCode extension

Browser extension (Manifest V3, works in Edge and Chrome) that records tab and focus
events while a student has tracking turned on, and uploads them in batches to the backend.

## Files

| File | What it is |
|---|---|
| `manifest.json` | ID card and permission list. JSON cannot hold comments, so each field is explained below |
| `config.js` | Every setting: API URL, batch size, timers, site categories |
| `api.js` | The one function every network call uses (timeout + uniform errors) |
| `background.js` | The brain: watches events, buffers, uploads, retries, ends sessions |
| `popup.html` / `popup.css` / `popup.js` | The toolbar popup: login, register, Start, Stop, status |

## manifest.json, field by field

| Field | What it does |
|---|---|
| `manifest_version: 3` | Which rulebook the extension follows. Must be 3 |
| `name`, `version`, `description` | Shown on the extensions page. Raise `version` on every published update |
| `permissions: tabs` | Lets the extension read tab URLs (needed to get the domain and detect the form submit) |
| `permissions: storage` | Lets it keep state in `chrome.storage.local` (survives the worker sleeping) |
| `permissions: alarms` | Timers that wake the sleeping worker (heartbeat, retries) |
| `permissions: idle` | Tells it when the user is idle or the screen is locked |
| `host_permissions` | Servers the extension may call. Must include your `API_BASE_URL` origin |
| `background.service_worker` | The file that runs in the background (`background.js`) |
| `background.type: module` | Allows `import` inside `background.js` |
| `action.default_popup` | The page shown when the toolbar icon is clicked |
| `action.default_title` | Tooltip text on the toolbar icon |

## Run it in Edge

1. Edit `config.js` (`API_BASE_URL`) and `manifest.json` (`host_permissions`) to match your backend.
2. Open `edge://extensions`, turn on **Developer mode**, click **Load unpacked**, pick this folder.
3. After code changes, click the reload icon on the extension card.
4. Debug the background code: click **service worker** on the extension card.
   Debug the popup: right-click the icon, then **Inspect popup**.

For testing without a real Google Form, set `ALLOW_ANY_PAGE_AS_QUIZ: true` in `config.js`.

## How a session flows

```
Popup: Turn on tracking
  -> background: POST /api/session/start  -> session_id
  -> state = monitoring, event "monitoring_started"
Browser events -> events buffered in storage (seq 1, 2, 3 ...)
Every 15 s / 20 events / urgent event / 30 s heartbeat tick -> POST /api/events (batch)
Form submitted (/formResponse) or Stop pressed
  -> event "monitoring_stopped", state = flushing
  -> upload everything left -> POST /api/session/end -> state = idle
```

## Event types

| type | When | Useful fields |
|---|---|---|
| `monitoring_started` | Tracking turned on | domain, category |
| `heartbeat` | Every 30 s | none |
| `tab_left` | First move away from the quiz tab | domain, category |
| `tab_switched` | Hop between two non-quiz tabs | domain, category |
| `tab_navigated` | A non-quiz tab loads a new site | domain, category |
| `tab_returned` | Back on the quiz tab | duration_ms away, domain visited |
| `browser_unfocused` | Browser lost focus to another app | none |
| `browser_focused` | Browser regained focus | duration_ms |
| `idle_state` | active / idle / locked change | detail |
| `quiz_tab_navigated` | Quiz tab sent to another site | domain, category |
| `quiz_tab_closed` | Quiz tab was closed | none |
| `quiz_submitted` | Form confirmation page detected | none |
| `monitoring_stopped` | Tracking turned off | detail = end reason |
| `resumed` | Browser restarted mid-session | detail |

Every event also has `seq`, `client_ts` (ISO UTC), and nullable `domain`, `category`, `duration_ms`, `detail`.

## What the backend must support

- `POST /api/register` `{email, name, password, course_code}`
- `POST /api/login` `{email, password}` -> `{ok:true, token, student:{student_id, email, name}}`
- `POST /api/session/start` `{quiz_id, client_ts}` -> `{ok:true, session_id}`
- `POST /api/events` `{batch_id, session_id, events:[...]}` (ignore a repeated `batch_id`, or answer `DUPLICATE_BATCH`)
- `POST /api/session/end` `{session_id, end_reason, ended_at, last_seq}`
- Errors use `{ok:false, error:{code, message}}`. A 401 means "log in again" (data is kept).
  Other 4xx codes cause that batch to be dropped. 5xx, 429 and timeouts are retried.
- The `detail` field on events is an addition to the earlier draft schema; add it to the spec and the sheet.

## Known limits

- Only sees the browser. Word or a PDF reader shows only as `browser_unfocused`.
- If the quiz tab is the only tab, brief focus flickers (e.g. a notification) can produce short unfocus events.
- Events recorded in the last second before a crash can be lost until the next wake-up.
- The login token is stored in `chrome.storage.local`, which is not encrypted. Use short token expiry.
- Incognito windows are not covered unless the student enables the extension there.
- Packed extensions get a fixed ID only if you set a `key` in `manifest.json`. Do that before adding CORS rules.
