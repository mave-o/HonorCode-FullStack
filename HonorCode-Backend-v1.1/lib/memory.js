// lib/memory.js
// An in-memory stand-in for Google Sheets, with the same four functions as sheets.js.
// Used for local development and the smoke test, so nobody needs Google credentials
// just to try the API. Data disappears on restart. env.js blocks it in production.

const tabs = new Map(); // tab name -> array of rows (header not included)
const rows = (tab) => { if (!tabs.has(tab)) tabs.set(tab, []); return tabs.get(tab); };

export const memoryStore = {
  // All data rows of a tab (copies, so callers cannot change stored data by accident).
  async readRows(tab) { return rows(tab).map((r) => [...r]); },
  // Adds rows to the end of a tab.
  async appendRows(tab, newRows) { rows(tab).push(...newRows.map((r) => r.map(String))); },
  // Overwrites cells in one row. rowNumber is the SHEET row (header = 1, first data row = 2).
  async updateCells(tab, rowNumber, firstCol, values) {
    const r = rows(tab)[rowNumber - 2];
    if (!r) throw new Error("row not found");
    values.forEach((v, i) => { r[firstCol - 1 + i] = String(v); });
  },
  async ensureSchema() { return { created: [], headersWritten: [], warnings: [] }; }
};
