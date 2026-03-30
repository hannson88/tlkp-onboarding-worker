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

function unique(arr) {
  return Array.from(new Set(arr));
}

function getLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function extractDirectPhonesFromWholeText(text) {
  const matches = String(text || "").match(/\b[89]\d{7}\b/g) || [];
  return unique(matches);
}

function extractPhonesFromSingleLine(line) {
  const candidates = [];

  const compact = normalizeDigits(line);
  if (isLikelySingaporeMobile(compact)) {
    candidates.push(compact);
  }

  const spaced = line.match(/\b([89]\d{3})\s+(\d{4})\b/g) || [];
  for (const s of spaced) {
    const digits = normalizeDigits(s);
    if (isLikelySingaporeMobile(digits)) {
      candidates.push(digits);
    }
  }

  return unique(candidates);
}

function scorePhoneCandidate(candidate, line, idx, lines) {
  let score = 0;
  const lower = line.toLowerCase();

  if (isLikelySingaporeMobile(candidate)) score += 50;

  if (lower.includes("customer")) score += 5;
  if (lower.includes("phone")) score += 15;
  if (lower.includes("mobile")) score += 15;
  if (lower.includes("contact")) score += 10;
  if (lower.includes("singapore")) score += 3;
  if (lower.includes("@")) score += 10;

  if (idx > 0) {
    const prev = lines[idx - 1].toLowerCase();
    if (prev.includes("customer")) score += 20;
    if (prev.includes("singapore")) score += 5;
  }

  if (idx < lines.length - 1) {
    const next = lines[idx + 1].toLowerCase();
    if (next.includes("@")) score += 20;
    if (next.includes("description")) score += 10;
  }

  if (/^\d{4}\s+\d{4}$/.test(line.trim())) score += 35;
  if (/^[89]\d{7}$/.test(line.trim())) score += 35;

  return score;
}

function extractImprovedPhones(text) {
  const lines = getLines(text);
  const directPhones = extractDirectPhonesFromWholeText(text);

  const scored = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const linePhones = extractPhonesFromSingleLine(line);

    for (const phone of linePhones) {
      scored.push({
        phone,
        line,
        lineIndex: i,
        score: scorePhoneCandidate(phone, line, i, lines)
      });
    }
  }

  for (const phone of directPhones) {
    if (!scored.find((x) => x.phone === phone)) {
      scored.push({
        phone,
        line: "[global direct match]",
        lineIndex: -1,
        score: 40
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    directPhones,
    scoredCandidates: scored,
    bestPhone: scored.length ? scored[0].phone : null
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
    console.error("  node test-phone-extract-v2.js <GOOGLE_DRIVE_FILE_ID>");
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
  const improved = extractImprovedPhones(ocrResult.text || "");

  printSection("CURRENT SYSTEM EXTRACTION");
  console.dir(currentSignals, { depth: null, colors: true });

  printSection("IMPROVED PHONE CANDIDATES");
  console.dir(improved.scoredCandidates, { depth: null, colors: true });

  printSection("BEST PHONE");
  console.dir({ bestPhone: improved.bestPhone }, { depth: null, colors: true });

  printSection("COMPARISON");
  console.dir(
    {
      currentPhones: currentSignals.phones || [],
      improvedBestPhone: improved.bestPhone,
      improvedAllPhones: unique(improved.scoredCandidates.map((x) => x.phone))
    },
    { depth: null, colors: true }
  );
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
