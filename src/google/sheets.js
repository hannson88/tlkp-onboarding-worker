const config = require("../config");
const { CACHE_HEADERS } = require("../cache/schema");

async function ensureCacheHeaderRow(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SHEET_ID,
    range: `${config.CACHE_SHEET_NAME}!1:1`
  });

  const existing = res.data.values?.[0] || [];

  const matches =
    existing.length === CACHE_HEADERS.length &&
    CACHE_HEADERS.every((h, i) => existing[i] === h);

  if (!matches) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.SHEET_ID,
      range: `${config.CACHE_SHEET_NAME}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [CACHE_HEADERS] }
    });
  }
}

async function readSourceRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SHEET_ID,
    range: config.SOURCE_SHEET_NAME
  });

  const rows = res.data.values || [];

  return {
    headers: rows[0] || [],
    dataRows: rows.slice(1)
  };
}

async function readExistingCacheMap(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SHEET_ID,
    range: `${config.CACHE_SHEET_NAME}!A:A`
  });

  const rows = res.data.values || [];
  const map = new Map();

  for (let i = 1; i < rows.length; i += 1) {
    const val = rows[i]?.[0];
    if (val) {
      map.set(String(val), i + 1);
    }
  }

  return map;
}

function normalizeCellValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function rowObjectToArray(rowObj) {
  return CACHE_HEADERS.map((header) => normalizeCellValue(rowObj[header]));
}

function normalizeRowsForWrite(rows) {
  return (rows || []).map((row) => {
    if (Array.isArray(row)) {
      return row.map((cell) => normalizeCellValue(cell));
    }

    if (row && typeof row === "object") {
      return rowObjectToArray(row);
    }

    throw new Error("Invalid row type passed to upsertRows; expected array or object");
  });
}

async function upsertRows(sheets, rows, existingMap) {
  const normalizedRows = normalizeRowsForWrite(rows);

  if (normalizedRows.length === 0) {
    return { inserted: 0, updated: 0 };
  }

  if (existingMap.size === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.SHEET_ID,
      range: `${config.CACHE_SHEET_NAME}!A2`,
      valueInputOption: "RAW",
      requestBody: { values: normalizedRows }
    });

    return { inserted: normalizedRows.length, updated: 0 };
  }

  const updates = [];
  const appends = [];

  for (const row of normalizedRows) {
    const key = row[0];
    const existing = existingMap.get(String(key));

    if (existing) {
      updates.push({
        range: `${config.CACHE_SHEET_NAME}!A${existing}`,
        values: [row]
      });
    } else {
      appends.push(row);
    }
  }

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.SHEET_ID,
      requestBody: {
        valueInputOption: "RAW",
        data: updates
      }
    });
  }

  if (appends.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.SHEET_ID,
      range: `${config.CACHE_SHEET_NAME}!A:A`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: appends }
    });
  }

  return { inserted: appends.length, updated: updates.length };
}

module.exports = {
  ensureCacheHeaderRow,
  readSourceRows,
  readExistingCacheMap,
  upsertRows
};
