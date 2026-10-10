// scripts/setup-sheet.js
// One-time (and safe to repeat) setup of your Google Sheet:
//   - creates the "accounts", "sessions" and "logs" tabs if they are missing
//   - writes the header row on any tab that has none
//   - never overwrites a header that already exists; it warns instead
// It also proves your service account can reach the sheet.
//
// Run:  npm run setup:sheet      (reads your .env file)

import { sheetsStore } from "../lib/sheets.js";

try {
  const report = await sheetsStore.ensureSchema();
  console.log("Tabs created:   ", report.created.join(", ") || "none (already there)");
  console.log("Headers written:", report.headersWritten.join(", ") || "none (already there)");
  for (const w of report.warnings) console.warn("WARNING:", w);
  console.log("\nSheet is ready.");
} catch (e) {
  console.error("\nSetup failed:", e.message);
  console.error("Check: GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY,");
  console.error("that the Sheets API is enabled, and that the sheet is shared with the service account as Editor.");
  process.exit(1);
}
