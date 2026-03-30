require("dotenv").config();

const config = require("./src/config");
const { getDriveClient, getFileMetadata } = require("./src/google/drive");
const { extractTextFromDriveFile } = require("./src/ocr/extract");
const { extractSignalsFromText } = require("./src/ocr/signals");

function normalizeDigits(input) {
  return String(input || "").replace(/\D/g, "");
}

function isLikelySingaporeMobile(num) {
  return /^[89]\d{7}$/.test(num);
}

function extractLongDigitRuns(text) {
  const matches = String(text || "").match(/\d[\d\s\-()]{7,}/g) || [];
  return matches
    .map((x) => x.trim())
    .filter(Boolean);
}

function extractSlidingPhoneCandidatesFromRun(run) {
  const digits = normalizeDigits(run);
  const candidates = new Set();

  if (digits.length < 8) return [];

  for (let i = 0; i <= digits.length - 8; i += 1) {
    const chunk = digits.slice(i, i + 8);
    if (isLikelySingaporeMobile(chunk)) {
      candidates.add(chunk);
    }
  }

  return Array.from(candidates);
}

function extractImprovedPhoneCandidates(text) {
  const candidates = new Set();

  const directMatches = String(text || "").match(/\b[89]\d{7}\b/g) || [];
  for (const m of directMatches) {
    candidates.add(m);
  }

  const longRuns = extractLongDigitRuns(text);
  for (const run of longRuns) {
    const subCandidates = extractSlidingPhoneCandidatesFromRun(run);
    for (const c of subCandidates) {
      candidates.add(c);
    }
  }

  return {
    longRuns,
    phoneCandidates: Array.from(candidates)
  };
}

function printSection(title) {
  console.log("\n" + "=".repeat(80));
  console.log(title);
  console.log("=".repeat(80));
}

async function main() {
  const fileId = process.argv[2] || process.env.FILE_ID;

  if (!fileId) {
    console.error("Usage:");
    console.error("  node test-phone-extract.js <GOOGLE_DRIVE_FILE_ID>");
    console.error("");
    console.error("Or:");
    console.error("  FILE_ID=<GOOGLE_DRIVE_FILE_ID> node test-phone-extract.js");
    process.exit(1);
  }

  console.log(`[INFO] Sheet ID from config: ${config.SHEET_ID}`);
  console.log(`[INFO] Testing file ID: ${fileId}`);

  const drive = await getDriveClient();
  const fileMeta = await getFileMetadata(drive, fileId);

  printSection("FILE METADATA");
  console.dir(fileMeta, { depth: null, colors: true });

  const ocrResult = await extractTextFromDriveFile(drive, fileMeta);

  printSection("OCR RESULT SUMMARY");
  console.dir(
    {
      status: ocrResult.status,
      error: ocrResult.error || "",
      textLength: (ocrResult.text || "").length
    },
    { depth: null, colors: true }
  );

  printSection("RAW OCR TEXT");
  console.log(ocrResult.text || "[EMPTY OCR TEXT]");

  const currentSignals = extractSignalsFromText(ocrResult.text || "");
  const improved = extractImprovedPhoneCandidates(ocrResult.text || "");

  printSection("CURRENT SYSTEM EXTRACTION");
  console.dir(currentSignals, { depth: null, colors: true });

  printSection("LONG DIGIT RUNS FOUND");
  console.dir(improved.longRuns, { depth: null, colors: true });

  printSection("IMPROVED PHONE CANDIDATES");
  console.dir(improved.phoneCandidates, { depth: null, colors: true });

  printSection("COMPARISON");
  console.dir(
    {
      currentPhones: currentSignals.phones || [],
      improvedPhones: improved.phoneCandidates || []
    },
    { depth: null, colors: true }
  );
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
