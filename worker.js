const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { google } = require("googleapis");

dotenv.config();

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SOURCE_SHEET_NAME = process.env.SOURCE_SHEET_NAME || "Form Responses 1";
const CACHE_SHEET_NAME = process.env.CACHE_SHEET_NAME || "verification_cache";
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const CACHE_HEADERS = [
  "source_row_number",
  "timestamp",
  "email",
  "full_name",
  "phone_applicant_raw",
  "phone_applicant_norm",
  "phone_owner_raw",
  "phone_owner_norm",
  "upload_links_raw",
  "file_count",
  "best_file_id",
  "best_file_type",
  "best_doc_class",
  "match_phone_applicant",
  "match_phone_owner",
  "match_email",
  "match_name",
  "match_vin",
  "confidence_score",
  "validation_status",
  "validation_reason",
  "processed_at",
  "notes"
];

function requireEnv(name, value) {
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function loadServiceAccountCredentials() {
  requireEnv("GOOGLE_SERVICE_ACCOUNT_JSON", GOOGLE_SERVICE_ACCOUNT_JSON);

  const fullPath = path.resolve(GOOGLE_SERVICE_ACCOUNT_JSON);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Service account JSON file not found: ${fullPath}`);
  }

  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

async function getSheetsClient() {
  requireEnv("GOOGLE_SHEET_ID", SHEET_ID);

  const credentials = loadServiceAccountCredentials();

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  const authClient = await auth.getClient();

  return google.sheets({
    version: "v4",
    auth: authClient
  });
}

function normalizeHeader(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractAllPhones(input) {
  if (!input) return [];

  const text = String(input);
  const matches = text.match(/(?:\+65\s*)?[89]\d{3}\s*\d{4}/g);

  if (!matches) return [];

  const normalized = matches.map((m) => m.replace(/\D/g, "").slice(-8));

  // unique while preserving order
  return [...new Set(normalized)];
}

function cleanOwnerField(input) {
  if (!input) return "";

  const val = String(input).trim().toLowerCase();

  if (
    val === "" ||
    val === "nil" ||
    val === "na" ||
    val === "no" ||
    val === "-"
  ) {
    return "";
  }

  return String(input);
}

function splitUploadLinks(raw) {
  if (!raw) return [];

  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractDriveFileId(url) {
  if (!url) return "";

  const text = String(url).trim();

  const openIdMatch = text.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (openIdMatch) return openIdMatch[1];

  const fileMatch = text.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return fileMatch[1];

  return "";
}

function toIsoNow() {
  return new Date().toISOString();
}

function getCell(row, index) {
  if (index === undefined || index === null || index < 0) return "";
  return row[index] ?? "";
}

function buildHeaderLookup(headers) {
  return headers.map((header, index) => ({
    raw: String(header || ""),
    normalized: normalizeHeader(header),
    index
  }));
}

function findHeaderIndex(headers, matcher) {
  const found = headers.find(matcher);
  return found ? found.index : -1;
}

function assertRequiredHeaders(headerLookup) {
  const requiredChecks = [
    {
      name: "Timestamp",
      ok: findHeaderIndex(headerLookup, (h) => h.normalized === "timestamp") >= 0
    },
    {
      name: "Email Address",
      ok: findHeaderIndex(headerLookup, (h) => h.normalized === "email address") >= 0
    },
    {
      name: "Full Name",
      ok: findHeaderIndex(headerLookup, (h) => h.normalized === "full name") >= 0
    },
    {
      name: "Contact Number",
      ok:
        findHeaderIndex(
          headerLookup,
          (h) => h.normalized === "contact number" || h.normalized.startsWith("contact number ")
        ) >= 0
    },
    {
      name: "Upload File",
      ok: findHeaderIndex(headerLookup, (h) => h.normalized.includes("upload")) >= 0
    },
    {
      name: "VIN / RN Number",
      ok: findHeaderIndex(headerLookup, (h) => h.normalized.includes("vin")) >= 0
    }
  ];

  const missing = requiredChecks.filter((x) => !x.ok).map((x) => x.name);

  if (missing.length > 0) {
    throw new Error(`Missing required source headers: ${missing.join(" | ")}`);
  }
}

async function ensureCacheHeaderRow(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${CACHE_SHEET_NAME}!1:1`
  });

  const existing = res.data.values?.[0] || [];
  const existingTrimmed = existing.map((x) => String(x).trim());

  const matches =
    existingTrimmed.length === CACHE_HEADERS.length &&
    CACHE_HEADERS.every((h, i) => existingTrimmed[i] === h);

  if (matches) {
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${CACHE_SHEET_NAME}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [CACHE_HEADERS] }
  });
}

async function readSourceRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SOURCE_SHEET_NAME
  });

  const rows = res.data.values || [];
  if (rows.length === 0) {
    return { headerLookup: [], dataRows: [] };
  }

  const headers = rows[0];
  const headerLookup = buildHeaderLookup(headers);

  assertRequiredHeaders(headerLookup);

  return {
    headerLookup,
    dataRows: rows.slice(1)
  };
}

async function readExistingCacheMap(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${CACHE_SHEET_NAME}!A:A`
  });

  const rows = res.data.values || [];
  const map = new Map();

  for (let i = 1; i < rows.length; i += 1) {
    const sourceRowNumber = rows[i]?.[0];
    if (sourceRowNumber) {
      map.set(String(sourceRowNumber), i + 1);
    }
  }

  return map;
}

function buildCacheRow(headerLookup, row, rowNumber) {
  const idxTimestamp = findHeaderIndex(headerLookup, (h) => h.normalized === "timestamp");
  const idxEmail = findHeaderIndex(headerLookup, (h) => h.normalized === "email address");
  const idxName = findHeaderIndex(headerLookup, (h) => h.normalized === "full name");
  const idxContact = findHeaderIndex(
    headerLookup,
    (h) => h.normalized === "contact number" || h.normalized.startsWith("contact number ")
  );
  const idxUpload = findHeaderIndex(headerLookup, (h) => h.normalized.includes("upload"));
  const idxOwner = findHeaderIndex(
    headerLookup,
    (h) => h.normalized.includes("owner's contact number") || h.normalized.includes("owners contact number")
  );
  const idxVin = findHeaderIndex(headerLookup, (h) => h.normalized.includes("vin"));
  const idxAdditionalComments = findHeaderIndex(
    headerLookup,
    (h) => h.normalized === "additional comments"
  );
  const idxOtherComments = findHeaderIndex(
    headerLookup,
    (h) => h.normalized === "other comments"
  );

  const timestamp = getCell(row, idxTimestamp);
  const email = getCell(row, idxEmail);
  const name = getCell(row, idxName);

  const applicantRaw = getCell(row, idxContact);
  const ownerRawOriginal = getCell(row, idxOwner);
  const ownerRawCleaned = cleanOwnerField(ownerRawOriginal);

  const uploadRaw = getCell(row, idxUpload);
  const vin = getCell(row, idxVin);
  const additionalComments = getCell(row, idxAdditionalComments);
  const otherComments = getCell(row, idxOtherComments);

  const applicantPhones = extractAllPhones(applicantRaw);
  const ownerPhones = extractAllPhones(ownerRawCleaned);

  let applicant = applicantPhones[0] || "";
  let owner = "";

  if (ownerPhones.length > 0) {
    owner = ownerPhones[0];
  } else if (applicantPhones.length > 1) {
    owner = applicantPhones[1];
  }

  if (owner && owner === applicant) {
    owner = "";
  }

  const links = splitUploadLinks(uploadRaw);
  const firstFileId = links.length > 0 ? extractDriveFileId(links[0]) : "";

  const notesParts = [];
  if (vin) notesParts.push(`form_vin_rn=${vin}`);
  if (additionalComments) notesParts.push(`additional_comments=${additionalComments}`);
  if (otherComments) notesParts.push(`other_comments=${otherComments}`);

  return [
    String(rowNumber),
    timestamp,
    email,
    name,
    applicantRaw,
    applicant,
    ownerRawOriginal,
    owner,
    uploadRaw,
    String(links.length),
    firstFileId,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "PENDING",
    "skeleton row created",
    toIsoNow(),
    notesParts.join(" | ")
  ];
}

async function upsertCacheRows(sheets, rowsToWrite, existingMap) {
  if (rowsToWrite.length === 0) {
    return { inserted: 0, updated: 0 };
  }

  if (existingMap.size === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${CACHE_SHEET_NAME}!A2`,
      valueInputOption: "RAW",
      requestBody: {
        values: rowsToWrite
      }
    });

    return { inserted: rowsToWrite.length, updated: 0 };
  }

  const updates = [];
  const appends = [];
  let updated = 0;

  for (const row of rowsToWrite) {
    const sourceRowNumber = String(row[0]);
    const existingRowNumber = existingMap.get(sourceRowNumber);

    if (existingRowNumber) {
      updates.push({
        range: `${CACHE_SHEET_NAME}!A${existingRowNumber}`,
        values: [row]
      });
      updated += 1;
    } else {
      appends.push(row);
    }
  }

  // Google batchUpdate can still be quota-sensitive if huge, so chunk it.
  const chunkSize = 200;

  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: "RAW",
        data: chunk
      }
    });
  }

  if (appends.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${CACHE_SHEET_NAME}!A:A`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: appends
      }
    });
  }

  return {
    inserted: appends.length,
    updated
  };
}

async function main() {
  const sheets = await getSheetsClient();

  console.log("[1/5] Ensuring verification_cache header row...");
  await ensureCacheHeaderRow(sheets);

  console.log("[2/5] Reading source rows...");
  const { headerLookup, dataRows } = await readSourceRows(sheets);
  console.log(`[INFO] Source rows found: ${dataRows.length}`);

  console.log("[3/5] Reading existing cache rows...");
  const existingMap = await readExistingCacheMap(sheets);
  console.log(`[INFO] Existing cache rows found: ${existingMap.size}`);

  console.log("[4/5] Building cache rows...");
  const rowsToWrite = dataRows.map((rowValues, index) =>
    buildCacheRow(headerLookup, rowValues, index + 2)
  );

  console.log("[5/5] Upserting cache rows...");
  const result = await upsertCacheRows(sheets, rowsToWrite, existingMap);

  console.log("[DONE] Worker skeleton completed.");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
