# HonorCode-FullStack-v1.1

A browser extension that tracks a student's browser activity during a quiz/exam, uploads the activity logs to a backend, and stores them in a Google Sheet for the instructor to review.

## Project layout

- `HonorCode-Extension-v1.1/` — the browser extension (student side).
- `HonorCode-Backend-v1.1/` — Vercel serverless API and Google Sheets integration (instructor side).

## Step-by-step: use the extension

### 1. Set up the backend

The extension needs a running backend to receive the logs.

1. Open `HonorCode-Backend-v1.1`.
2. Follow its README to install dependencies, configure the Google Sheet/service account, and run `npm run setup:sheet`.
3. Run `npx vercel dev` locally for testing, or deploy to Vercel for production.
4. Note the backend URL (for example `http://localhost:3000` or `https://your-project.vercel.app`).

### 2. Configure and load the extension

1. Open `HonorCode-Extension-v1.1`.
2. Copy `.env.example` to `.env` and set `API_BASE_URL` to your backend URL (no trailing slash).
3. Run `node scripts/build-env.js`. This generates `env.js` and updates `manifest.json` with the correct permissions.
4. Open Chrome or Edge and go to `chrome://extensions` or `edge://extensions`.
5. Turn on **Developer mode**, then click **Load unpacked**.
6. Select the `HonorCode-Extension-v1.1` folder. The HonorCode icon should appear in the toolbar.

### 3. Start a quiz session

1. Open the quiz in your browser. By default the quiz must be a Google Form URL starting with `https://docs.google.com/forms/`.
2. Click the HonorCode icon in the toolbar.
3. Log in, or click **Register** if this is your first time. Registering requires email, full name, password, and the course code your instructor gave you.
4. Read the disclosure that explains what is recorded.
5. Check the consent box and click **Turn on tracking**. The status pill changes to **Tracking on**.

### 4. Take the quiz

- The extension records when you leave the quiz tab, which domain you switch to, when the browser loses focus, and idle/lock state changes.
- It does **not** record page contents, keystrokes, screenshots, or the full URL — only domains and timestamps.

### 5. Finish the quiz

- Tracking stops automatically when the Google Form is submitted.
- If your instructor enabled manual stop, you can also click **Turn off tracking** in the popup.
- Once tracking ends, the remaining logs are uploaded to the backend and written to the Google Sheet.

### 6. Review the data

The instructor opens the linked Google Sheet to view the `accounts`, `sessions`, and `logs` tabs. See `HonorCode-Backend-v1.1/README.md` for the sheet layout and filter tips.

## Development/testing tips

- To test without a real Google Form, set `ALLOW_ANY_PAGE_AS_QUIZ=true` in the extension's `.env` before running `build-env.js`. **Only use this for local testing.**
- If the popup says your login expired, log in again. No locally buffered data is lost.
- After changing extension code or `.env`, reload the extension from the extensions page, or run `build-env.js` again if `.env` changed.

## More details

- Extension internals: `HonorCode-Extension-v1.1/README.md`
- Backend API, deployment, and sheet setup: `HonorCode-Backend-v1.1/README.md`
