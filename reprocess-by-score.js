require("dotenv").config();

const config = require("./src/config");

const { getSheetsClient } = require("./src/google/auth");
const { getDriveClient, getFileMetadata } = require("./src/google/drive");
const {
  ensureCacheHeaderRow,
  readSourceRows,
  readExistingCacheMap,
  upsertRows
} = require("./src/google/sheets");

const { extractTextFromDriveFile } = require("./src/ocr/extract");
const { extractSignalsFromText } = require("./src/ocr/signals");
const { compareSignals } = require("./src/matching/compare");
const { scoreValidation } = require("./src/matching/score");
const { extractSourceContext, buildRow } = require("./src/cache/builder");

async function readCacheRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SHEET_ID,
    range: config.CACHE_SHEET_NAME
  });

  const rows = res.data.values || [];
  if (rows.length <= 1) {
    return [];
  }

  const headers = rows[0].map((x) => String(x || "").trim());

  return rows.slice(1).map((row, idx) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] || "";
    });
    obj._sheetRowNumber = idx + 2;
    return obj;
  });
}

function asNumber(value, fallback = null) {
  const n = Number(String(value || "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function statusRank(status) {
  const s = String(status || "").trim().toUpperCase();

  if (s === "DOC_OK_HIGH") return 5;
  if (s === "DOC_OK_MEDIUM") return 4;
  if (s === "DOC_OK_LOW") return 3;
  if (s === "DOC_REVIEW") return 2;
  if (s === "OCR_FAILED") return 1;
  return 0;
}

function countTrueMatches(matches) {
  let count = 0;
  if (matches?.matchPhoneApplicant) count += 1;
  if (matches?.matchPhoneOwner) count += 1;
  if (matches?.matchEmail) count += 1;
  if (matches?.matchName) count += 1;
  if (matches?.matchVin) count += 1;
  return count;
}

function getConfidence(score) {
  if (!score || typeof score !== "object") return -1;
  if (Number.isFinite(Number(score.confidenceScore))) return Number(score.confidenceScore);
  if (Number.isFinite(Number(score.confidence_score))) return Number(score.confidence_score);
  if (Number.isFinite(Number(score.score))) return Number(score.score);
  return -1;
}

function getStatus(score) {
  if (!score || typeof score !== "object") return "DOC_REJECT";
  return (
    score.validationStatus ||
    score.validation_status ||
    score.status ||
    "DOC_REJECT"
  );
}

function shouldIncludeRow(cacheRow, opts, source) {
  const fileType = String(cacheRow.best_file_type || "").trim().toLowerCase();
  const score = asNumber(cacheRow.confidence_score, -1);
  const fileCount = Number(source.fileCount || 0);
  const sourceRowNumber = String(cacheRow.source_row_number || "").trim();

  if (opts.sourceRowNumber && sourceRowNumber !== String(opts.sourceRowNumber)) {
    return false;
  }

  if (opts.fileType && fileType !== opts.fileType) {
    return false;
  }

  if (opts.excludePdf && fileType === "pdf") {
    return false;
  }

  if (opts.minScore !== null && score < opts.minScore) {
    return false;
  }

  if (opts.maxScore !== null && score > opts.maxScore) {
    return false;
  }

  if (opts.onlyStatuses.length > 0) {
    const status = String(cacheRow.validation_status || "").trim();
    if (!opts.onlyStatuses.includes(status)) {
      return false;
    }
  }

  if (opts.minFiles !== null && fileCount < opts.minFiles) {
    return false;
  }

  return true;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    minScore: process.env.MIN_SCORE ? Number(process.env.MIN_SCORE) : null,
    maxScore: process.env.MAX_SCORE ? Number(process.env.MAX_SCORE) : null,
    maxRows: process.env.MAX_ROWS ? Number(process.env.MAX_ROWS) : null,
    minFiles: process.env.MIN_FILES ? Number(process.env.MIN_FILES) : null,
    sourceRowNumber: process.env.SOURCE_ROW_NUMBER ? String(process.env.SOURCE_ROW_NUMBER).trim() : null,
    excludePdf: true,
//    fileType: process.env.FILE_TYPE ? String(process.env.FILE_TYPE).trim().toLowerCase() : "image",
    fileType: process.env.FILE_TYPE ? String(process.env.FILE_TYPE).trim().toLowerCase() : null,
    onlyStatuses: process.env.ONLY_STATUSES
      ? String(process.env.ONLY_STATUSES).split(",").map((x) => x.trim()).filter(Boolean)
      : []
  };

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];

    if (a === "--min-score") out.minScore = Number(args[++i]);
    else if (a === "--max-score") out.maxScore = Number(args[++i]);
    else if (a === "--max-rows") out.maxRows = Number(args[++i]);
    else if (a === "--min-files") out.minFiles = Number(args[++i]);
    else if (a === "--source-row-number") out.sourceRowNumber = String(args[++i]).trim();
    else if (a === "--file-type") out.fileType = String(args[++i]).trim().toLowerCase();
    else if (a === "--include-pdf") out.excludePdf = false;
    else if (a === "--only-statuses") {
      out.onlyStatuses = String(args[++i]).split(",").map((x) => x.trim()).filter(Boolean);
    }
  }

  if (out.minScore !== null && !Number.isFinite(out.minScore)) {
    throw new Error(`Invalid min score: ${out.minScore}`);
  }
  if (out.maxScore !== null && !Number.isFinite(out.maxScore)) {
    throw new Error(`Invalid max score: ${out.maxScore}`);
  }
  if (out.maxRows !== null && (!Number.isFinite(out.maxRows) || out.maxRows <= 0)) {
    throw new Error(`Invalid max rows: ${out.maxRows}`);
  }
  if (out.minFiles !== null && (!Number.isFinite(out.minFiles) || out.minFiles <= 0)) {
    throw new Error(`Invalid min files: ${out.minFiles}`);
  }

  return out;
}

function compareCandidates(a, b) {
  if (a.confidence !== b.confidence) {
    return b.confidence - a.confidence;
  }

  const aStatusRank = statusRank(a.status);
  const bStatusRank = statusRank(b.status);
  if (aStatusRank !== bStatusRank) {
    return bStatusRank - aStatusRank;
  }

  if (a.matchCount !== b.matchCount) {
    return b.matchCount - a.matchCount;
  }

  return a.index - b.index;
}

async function evaluateBestFileForSource(drive, source) {
  const fileIds = Array.isArray(source.fileIds) ? source.fileIds : [];
  const candidates = [];

  if (fileIds.length === 0) {
    const fileMeta = {
      fileId: "",
      fileType: "missing",
      docClass: "DOC_REJECT",
      reason: "no_uploaded_file"
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
      fileMeta,
      ocrResult,
      extractedSignals,
      matches,
      score,
      confidence: getConfidence(score),
      status: getStatus(score),
      matchCount: countTrueMatches(matches),
      index: 0
    };
  }

  for (let i = 0; i < fileIds.length; i += 1) {
    const fileId = fileIds[i];

    try {
      const fileMeta = await getFileMetadata(drive, fileId);
      const ocrResult = await extractTextFromDriveFile(drive, fileMeta);
      const extractedSignals = extractSignalsFromText(ocrResult.text || "");
      const matches = compareSignals(source, extractedSignals);
      const score = scoreValidation(source, fileMeta, ocrResult, matches);

      candidates.push({
        fileMeta,
        ocrResult,
        extractedSignals,
        matches,
        score,
        confidence: getConfidence(score),
        status: getStatus(score),
        matchCount: countTrueMatches(matches),
        index: i
      });
    } catch (err) {
      const fileMeta = {
        fileId,
        fileType: "missing",
        docClass: "DOC_REJECT",
        reason: `file_eval_failed: ${err.message}`
      };

      const ocrResult = {
        ok: false,
        text: "",
        reason: `file_eval_failed: ${err.message}`
      };

      const extractedSignals = extractSignalsFromText("");
      const matches = compareSignals(source, extractedSignals);
      const score = scoreValidation(source, fileMeta, ocrResult, matches);

      candidates.push({
        fileMeta,
        ocrResult,
        extractedSignals,
        matches,
        score,
        confidence: getConfidence(score),
        status: getStatus(score),
        matchCount: countTrueMatches(matches),
        index: i
      });
    }
  }

  candidates.sort(compareCandidates);
  return candidates[0];
}

async function main() {
  const opts = parseArgs();

  const sheets = await getSheetsClient();
  const drive = await getDriveClient();

  console.log("[1/7] Ensuring cache...");
  await ensureCacheHeaderRow(sheets);

  console.log("[2/7] Reading source sheet...");
  const { headers, dataRows } = await readSourceRows(sheets);
  console.log(`[INFO] Source rows: ${dataRows.length}`);

  console.log("[3/7] Reading cache sheet...");
  const cacheRows = await readCacheRows(sheets);
  console.log(`[INFO] Cache rows: ${cacheRows.length}`);

  console.log("[4/7] Reading existing cache row map...");
  const existingMap = await readExistingCacheMap(sheets);
  console.log(`[INFO] Existing cache rows: ${existingMap.size}`);

  console.log("[INFO] Filters:");
  console.log(
    JSON.stringify(
      {
        minScore: opts.minScore,
        maxScore: opts.maxScore,
        maxRows: opts.maxRows,
        minFiles: opts.minFiles,
        sourceRowNumber: opts.sourceRowNumber,
        excludePdf: opts.excludePdf,
        fileType: opts.fileType,
        onlyStatuses: opts.onlyStatuses
      },
      null,
      2
    )
  );

  let candidates = cacheRows
    .map((cacheRow) => {
      const sourceRowNumber = String(cacheRow.source_row_number || "").trim();
      const sourceIndex = Number(sourceRowNumber) - 2;

      if (!sourceRowNumber || !Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= dataRows.length) {
        return null;
      }

      const sourceRow = dataRows[sourceIndex];
      const source = extractSourceContext(headers, sourceRow, Number(sourceRowNumber));

      return {
        cacheRow,
        sourceRowNumber,
        sourceIndex,
        source
      };
    })
    .filter(Boolean)
    .filter((item) => shouldIncludeRow(item.cacheRow, opts, item.source));

  console.log(`[INFO] Candidate rows before MAX_ROWS: ${candidates.length}`);

  if (opts.maxRows) {
    candidates = candidates.slice(0, opts.maxRows);
    console.log(`[INFO] MAX_ROWS=${opts.maxRows}`);
  } else {
    console.log("[INFO] MAX_ROWS=ALL");
  }

  console.log(`[INFO] Processing ${candidates.length} rows`);

  if (candidates.length === 0) {
    console.log("[5/7] Nothing to process.");
    console.log("[6/7] Skipping write.");
    console.log("[7/7] Done.");
    console.log("[DONE]", { inserted: 0, updated: 0 });
    return;
  }

  console.log("[5/7] Rebuilding selected rows...");
  const rows = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const item = candidates[i];
    const best = await evaluateBestFileForSource(drive, item.source);

    rows.push(
      buildRow(
        item.source,
        best.fileMeta,
        best.matches,
        best.score,
        best.ocrResult,
        best.extractedSignals
      )
    );

    if ((i + 1) % 10 === 0 || i + 1 === candidates.length) {
      console.log(
        `[INFO] Prepared ${i + 1}/${candidates.length} rows... source_row=${item.sourceRowNumber} best_file=${best.fileMeta?.fileId || "none"} score=${best.confidence}`
      );
    }
  }

  console.log("[6/7] Writing...");
  const result = await upsertRows(sheets, rows, existingMap);

  console.log("[7/7] Done.");
  console.log("[DONE]", result);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
