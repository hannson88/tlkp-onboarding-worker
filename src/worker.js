const config = require("./config");

const { getSheetsClient } = require("./google/auth");
const { getDriveClient, getFileMetadata } = require("./google/drive");
const {
  ensureCacheHeaderRow,
  readSourceRows,
  readExistingCacheMap,
  upsertRows
} = require("./google/sheets");

const { extractTextFromDriveFile } = require("./ocr/extract");
const { extractSignalsFromText } = require("./ocr/signals");
const { compareSignals } = require("./matching/compare");
const { scoreValidation } = require("./matching/score");
const { extractSourceContext, buildRow } = require("./cache/builder");

async function readCacheStatusMap(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SHEET_ID,
    range: config.CACHE_SHEET_NAME
  });

  const rows = res.data.values || [];
  const map = new Map();

  if (rows.length <= 1) {
    return map;
  }

  const headerRow = rows[0].map((x) => String(x || "").trim());
  const idxSourceRow = headerRow.indexOf("source_row_number");
  const idxValidationStatus = headerRow.indexOf("validation_status");

  if (idxSourceRow < 0 || idxValidationStatus < 0) {
    throw new Error(
      "verification_cache is missing source_row_number or validation_status header"
    );
  }

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const sourceRowNumber = row[idxSourceRow];
    const validationStatus = row[idxValidationStatus];

    if (sourceRowNumber) {
      map.set(String(sourceRowNumber), String(validationStatus || ""));
    }
  }

  return map;
}

function selectRowsToProcess(dataRows, cacheStatusMap, processMode) {
  if (processMode === "ocr_failed") {
    const selected = [];

    for (let i = 0; i < dataRows.length; i += 1) {
      const sourceRowNumber = String(i + 2);
      const currentStatus = cacheStatusMap.get(sourceRowNumber) || "";

      if (currentStatus === "OCR_FAILED") {
        selected.push({
          sourceRowNumber,
          row: dataRows[i]
        });
      }
    }

    return selected;
  }

  if (processMode === "pending" || processMode === "new_only") {
    const selected = [];

    for (let i = 0; i < dataRows.length; i += 1) {
      const sourceRowNumber = String(i + 2);
      const hasCache = cacheStatusMap.has(sourceRowNumber);

      if (!hasCache) {
        selected.push({
          sourceRowNumber,
          row: dataRows[i]
        });
      }
    }

    return selected;
  }

  return dataRows.map((row, i) => ({
    sourceRowNumber: String(i + 2),
    row
  }));
}

function getConfidenceScore(score) {
  if (!score || typeof score !== "object") return -1;
  if (Number.isFinite(Number(score.confidenceScore))) return Number(score.confidenceScore);
  if (Number.isFinite(Number(score.confidence_score))) return Number(score.confidence_score);
  if (Number.isFinite(Number(score.score))) return Number(score.score);
  return -1;
}

function getValidationStatus(score) {
  if (!score || typeof score !== "object") return "DOC_REJECT";
  return (
    score.validationStatus ||
    score.validation_status ||
    score.status ||
    "DOC_REJECT"
  );
}

function countPositiveMatches(matches) {
  let count = 0;
  if (matches?.matchPhoneApplicant) count += 1;
  if (matches?.matchPhoneOwner) count += 1;
  if (matches?.matchEmail) count += 1;
  if (matches?.matchName) count += 1;
  if (matches?.matchVin) count += 1;
  return count;
}

function countUsefulSignals(extractedSignals) {
  const phones = extractedSignals?.phones || [];
  const emails = extractedSignals?.emails || [];
  const vinRn = extractedSignals?.vinRn || [];
  return phones.length + emails.length + vinRn.length;
}

function statusRank(status) {
  switch (String(status || "").trim().toUpperCase()) {
    case "DOC_OK_HIGH":
      return 5;
    case "DOC_OK_MEDIUM":
      return 4;
    case "DOC_OK_LOW":
      return 3;
    case "DOC_REVIEW":
      return 2;
    case "OCR_FAILED":
      return 1;
    case "DOC_REJECT":
    default:
      return 0;
  }
}

function compareCandidates(a, b) {
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  if (a.statusRank !== b.statusRank) return b.statusRank - a.statusRank;
  if (a.matchCount !== b.matchCount) return b.matchCount - a.matchCount;
  if (a.usefulSignalCount !== b.usefulSignalCount) {
    return b.usefulSignalCount - a.usefulSignalCount;
  }
  if (a.ok !== b.ok) return Number(b.ok) - Number(a.ok);
  return a.index - b.index;
}

async function evaluateFileCandidate({
  drive,
  source,
  fileId,
  index
}) {
  const fileMeta = await getFileMetadata(drive, fileId);
  const ocrResult = await extractTextFromDriveFile(drive, fileMeta);
  const extractedSignals = extractSignalsFromText(ocrResult.text || "");
  const matches = compareSignals(source, extractedSignals);
  const score = scoreValidation(source, fileMeta, ocrResult, matches);

  return {
    index,
    fileId,
    fileMeta,
    ocrResult,
    extractedSignals,
    matches,
    score,
    confidence: getConfidenceScore(score),
    status: getValidationStatus(score),
    statusRank: statusRank(getValidationStatus(score)),
    matchCount: countPositiveMatches(matches),
    usefulSignalCount: countUsefulSignals(extractedSignals),
    ok: Boolean(ocrResult?.ok)
  };
}

async function pickBestFileCandidate({ drive, source }) {
  const fileIds = source.fileIds || [];

  if (fileIds.length === 0) {
    const fileMeta = {
      fileId: "",
      fileType: "missing",
      docClass: "DOC_REJECT",
      reason: "no uploaded file found"
    };

    const ocrResult = {
      ok: false,
      text: "",
      reason: "no_uploaded_file"
    };

    const extractedSignals = extractSignalsFromText("");
    const matches = compareSignals(source, extractedSignals);
    const score = scoreValidation(source, fileMeta, ocrResult, matches);

    return {
      index: 0,
      fileId: "",
      fileMeta,
      ocrResult,
      extractedSignals,
      matches,
      score,
      confidence: getConfidenceScore(score),
      status: getValidationStatus(score),
      statusRank: statusRank(getValidationStatus(score)),
      matchCount: countPositiveMatches(matches),
      usefulSignalCount: countUsefulSignals(extractedSignals),
      ok: false
    };
  }

  const candidates = [];

  for (let i = 0; i < fileIds.length; i += 1) {
    const fileId = fileIds[i];

    try {
      const candidate = await evaluateFileCandidate({
        drive,
        source,
        fileId,
        index: i
      });

      candidates.push(candidate);
    } catch (err) {
      candidates.push({
        index: i,
        fileId,
        fileMeta: {
          fileId,
          fileType: "missing",
          docClass: "DOC_REJECT",
          reason: `file_eval_failed: ${err.message}`
        },
        ocrResult: {
          ok: false,
          text: "",
          reason: `file_eval_failed: ${err.message}`
        },
        extractedSignals: extractSignalsFromText(""),
        matches: {
          matchPhoneApplicant: false,
          matchPhoneOwner: false,
          matchEmail: false,
          matchName: false,
          matchVin: false
        },
        score: {
          confidenceScore: -1,
          validationStatus: "DOC_REJECT",
          validationReason: `file_eval_failed: ${err.message}`
        },
        confidence: -1,
        status: "DOC_REJECT",
        statusRank: 0,
        matchCount: 0,
        usefulSignalCount: 0,
        ok: false
      });
    }
  }

  candidates.sort(compareCandidates);
  return candidates[0];
}

async function runWorker() {
  const sheets = await getSheetsClient();
  const drive = await getDriveClient();

  const processMode = String(process.env.PROCESS_MODE || "all").trim().toLowerCase();
  const maxRowsEnv = String(process.env.MAX_ROWS || "").trim();
  const maxRows = maxRowsEnv ? Number(maxRowsEnv) : null;

  if (!["all", "ocr_failed", "pending", "new_only"].includes(processMode)) {
    throw new Error(
      `Invalid PROCESS_MODE="${processMode}". Supported values: all, ocr_failed, pending, new_only`
    );
  }

  if (maxRowsEnv && (!Number.isFinite(maxRows) || maxRows <= 0)) {
    throw new Error(`Invalid MAX_ROWS="${maxRowsEnv}". Use a positive integer.`);
  }

  console.log("[1/7] Ensuring cache...");
  await ensureCacheHeaderRow(sheets);

  console.log("[2/7] Reading source...");
  const { headers, dataRows } = await readSourceRows(sheets);
  console.log(`[INFO] Source rows: ${dataRows.length}`);

  console.log("[3/7] Reading cache status...");
  const cacheStatusMap = await readCacheStatusMap(sheets);
  console.log(`[INFO] Cache status rows: ${cacheStatusMap.size}`);

  console.log("[4/7] Reading existing cache row map...");
  const existingMap = await readExistingCacheMap(sheets);
  console.log(`[INFO] Existing cache rows: ${existingMap.size}`);

  let candidates = selectRowsToProcess(dataRows, cacheStatusMap, processMode);

  console.log(`[INFO] PROCESS_MODE=${processMode}`);
  console.log(`[INFO] Candidate rows before MAX_ROWS: ${candidates.length}`);

  if (maxRows) {
    candidates = candidates.slice(0, maxRows);
    console.log(`[INFO] MAX_ROWS=${maxRows}`);
  } else {
    console.log("[INFO] MAX_ROWS=ALL");
  }

  console.log(`[INFO] Processing ${candidates.length} rows`);

  console.log("[5/7] Building rows + evaluating all uploaded files...");
  const rows = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const item = candidates[i];
    const source = extractSourceContext(headers, item.row, Number(item.sourceRowNumber));

    const bestCandidate = await pickBestFileCandidate({
      drive,
      source
    });

    rows.push(
      buildRow(
        source,
        bestCandidate.fileMeta,
        bestCandidate.matches,
        bestCandidate.score,
        bestCandidate.ocrResult,
        bestCandidate.extractedSignals
      )
    );

    if ((i + 1) % 10 === 0 || i + 1 === candidates.length) {
      console.log(
        `[INFO] Prepared ${i + 1}/${candidates.length} rows... best_file=${bestCandidate.fileMeta?.fileId || "none"} score=${bestCandidate.confidence}`
      );
    }
  }

  console.log("[6/7] Writing...");
  const result = await upsertRows(sheets, rows, existingMap);

  console.log("[7/7] Done.");
  console.log("[DONE]", result);
}

module.exports = { runWorker };
