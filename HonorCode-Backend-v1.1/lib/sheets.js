// lib/sheets.js
// Talks to the Google Sheets REST API using the service account.
// Only four functions are exposed (same as memory.js), so db.js does not care which is in use.
//
// QUOTA WARNING (Google): 60 reads/min and 60 writes/min per service account.
// Every function here costs exactly ONE request, and the endpoints are written
// to use as few as possible.

import { JWT } from "google-auth-library";
import { env } from "./env.js";
import { HttpError } from "./http.js";
import { TABS } from "./db-schema.js";

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";
let client = null; // reused between requests on a warm instance

// The authenticated Google client (created once).
function google() {
  if (!client) {
    const e = env();
    client = new JWT({ email: e.serviceEmail, key: e.privateKey, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  }
  return client;
}

// Column number (1 = A) to letter, for range strings like "F5:H5".
export function colLetter(n) {
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// One Google call. Any failure becomes a 503 so the extension keeps its data and retries.
async function call(method, path, { params, data } = {}) {
  try {
    const res = await google().request({
      url: `${BASE}/${env().sheetId}${path}`,
      method, params, data,
      timeout: 7000 // answer before the extension's 10 s timeout
    });
    return res.data;
  } catch (err) {
    const status = err && err.response && err.response.status;
    // Log the real reason for the developer; never send it to the client.
    console.error("[honorcode] Google Sheets error:", status || "", err && err.message);
    throw new HttpError(503, "STORAGE_UNAVAILABLE", "Storage is temporarily unavailable.", { "Retry-After": "5" });
  }
}

// "tab!A2:Z" as a URL-safe path piece.
const range = (r) => `/values/${encodeURIComponent(r)}`;

export const sheetsStore = {
  // All data rows of a tab (row 1 is the header and is skipped).
  async readRows(tab) {
    const width = colLetter(TABS[tab].length);
    const data = await call("GET", range(`${tab}!A2:${width}`));
    return (data.values || []).map((r) => r.map(String));
  },

  // Adds rows below the last one. RAW means text is stored exactly as sent, so a value
  // starting with "=" is never run as a spreadsheet formula.
  async appendRows(tab, rows) {
    await call("POST", `${range(`${tab}!A1`)}:append`, {
      params: { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" },
      data: { values: rows }
    });
  },

  // Overwrites cells in one row (rowNumber is the sheet row; firstCol is 1 for column A).
  async updateCells(tab, rowNumber, firstCol, values) {
    const a = colLetter(firstCol), b = colLetter(firstCol + values.length - 1);
    await call("PUT", range(`${tab}!${a}${rowNumber}:${b}${rowNumber}`), {
      params: { valueInputOption: "RAW" },
      data: { values: [values] }
    });
  },

  // One-time setup: creates missing tabs and writes header rows. Never overwrites existing headers.
  async ensureSchema() {
    const report = { created: [], headersWritten: [], warnings: [] };
    const meta = await call("GET", "", { params: { fields: "sheets.properties.title" } });
    const existing = new Set((meta.sheets || []).map((s) => s.properties.title));

    const missing = Object.keys(TABS).filter((t) => !existing.has(t));
    if (missing.length) {
      await call("POST", ":batchUpdate", { data: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) } });
      report.created.push(...missing);
    }
    for (const tab of Object.keys(TABS)) {
      const header = TABS[tab];
      const data = await call("GET", range(`${tab}!A1:${colLetter(header.length)}1`));
      const current = (data.values && data.values[0]) || [];
      if (current.length === 0) {
        await call("PUT", range(`${tab}!A1:${colLetter(header.length)}1`), { params: { valueInputOption: "RAW" }, data: { values: [header] } });
        report.headersWritten.push(tab);
      } else if (current.join("|") !== header.join("|")) {
        report.warnings.push(`${tab}: header row differs from the expected columns. Fix it by hand (column ORDER matters).`);
      }
    }
    return report;
  }
};
