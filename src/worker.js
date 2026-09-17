const config = require("./config");

const { getSheetsClient } = require("./google/auth");
const { getDriveClient, getFileMetadata } = require("./google/drive");
const {
  ensureCacheHeaderRow,
  readSourceRows,
  readExistingCacheMap,
  writeSourceFingerprintBaselines,
  upsertRows
} = require("./google/sheets");

const { extractTextFromDriveFile } = require("./ocr/extract");
const { extractSignalsFromText } = require("./ocr/signals");
const { compareSignals } = require("./matching/compare");
const { scoreValidation } = require("./matching/score");
const { extractSourceContext, buildRow } = require("./cache/builder");
const { sourceFingerprint, changedFields, isManualDecision } = require("./cache/fingerprint");

const APPROVED_STATUSES = new Set(["DOC_OK_MEDIUM", "DOC_OK_HIGH"]);
const PHONE_FIELDS = new Set(["phoneApplicant", "phoneOwner"]);

function appendNote(notes, entries) {
  return [notes, ...entries].filter(Boolean).join(" | ");
}

function protectApprovedDecision(cached, output, item) {
  if (!cached || item.reason !== "edited") {
    return { row: output, reviewRequired: false, statusPreserved: false };
  }

  const previousStatus = String(cached.validation_status || "").trim().toUpperCase();
  const attemptedStatus = String(output.validation_status || "").trim().toUpperCase();

  if (!APPROVED_STATUSES.has(previousStatus)) {
    return { row: output, reviewRequired: false, statusPreserved: false };
  }

  if (!APPROVED_STATUSES.has(attemptedStatus)) {
    const preserved = { ...cached };
    delete preserved._sheetRowNumber;
    preserved.source_fingerprint = output.source_fingerprint;
    preserved.notes = appendNote(cached.notes, [
      "source_edit_review_required=true",
      `changed_fields=${item.changedFields.join(",")}`,
      `attempted_validation_status=${attemptedStatus || "UNKNOWN"}`,
      `attempted_validation_reason=${String(output.validation_reason || "").replace(/\|/g, "/")}`,
      `review_detected_at=${new Date().toISOString()}`
    ]);
    return { row: preserved, reviewRequired: true, statusPreserved: true };
  }

  if (statusRank(previousStatus) > statusRank(attemptedStatus)) {
    output.validation_status = previousStatus;
    output.validation_reason = cached.validation_reason || output.validation_reason;
    output.notes = appendNote(output.notes, [
      `automatic_status_floor=${previousStatus}`,
      `automatic_recheck_status=${attemptedStatus}`
    ]);
    return { row: output, reviewRequired: false, statusPreserved: true };
  }

  return { row: output, reviewRequired: false, statusPreserved: false };
}

function isPhoneOnlyEdit(fields) {
  return fields.length > 0 && fields.every((field) => PHONE_FIELDS.has(field));
}

function applyPhoneOnlyEdit(cached, source, item) {
  const updated = { ...cached };
  delete updated._sheetRowNumber;
  updated.phone_applicant_raw = source.phoneApplicantRaw;
  updated.phone_applicant_norm = source.phoneApplicantNorm;
  updated.phone_owner_raw = source.phoneOwnerRaw;
  updated.phone_owner_norm = source.phoneOwnerNorm;
  updated.source_fingerprint = source.sourceFingerprint;
  updated.notes = appendNote(cached.notes, [
    "contact_edit_applied=true",
    `changed_fields=${item.changedFields.join(",")}`,
    `contact_updated_at=${new Date().toISOString()}`
  ]);
  return updated;
}

async function readCacheMetadataMap(sheets) {
  const res=await sheets.spreadsheets.values.get({spreadsheetId:config.SHEET_ID,range:config.CACHE_SHEET_NAME});
  const [headers=[],...rows]=res.data.values||[];
  const map=new Map();
  for(let i=0;i<rows.length;i++){
    const obj={_sheetRowNumber:i+2};
    headers.forEach((h,j)=>{obj[String(h||'').trim()]=rows[i][j]??'';});
    if(obj.source_row_number)map.set(String(obj.source_row_number),obj);
  }
  return map;
}

function prepareSourceItems(headers,dataRows){
  return dataRows.map((row,i)=>{
    const sourceRowNumber=String(i+2),source=extractSourceContext(headers,row,i+2);
    source.sourceFingerprint=sourceFingerprint(source);
    return {sourceRowNumber,row,source};
  });
}

function selectRowsToProcess(items,cacheMap,processMode,{editDetection=true}={}){
  if(processMode==='ocr_failed')return items.filter(x=>String(cacheMap.get(x.sourceRowNumber)?.validation_status||'')==='OCR_FAILED');
  if(processMode==='pending'||processMode==='new_only'){
    return items.filter(x=>{
      const cached=cacheMap.get(x.sourceRowNumber);
      if(!cached){x.reason='new';return true;}
      if(!editDetection||!cached.source_fingerprint||cached.source_fingerprint===x.source.sourceFingerprint)return false;
      x.changedFields=changedFields(x.source,cached);
      if(!x.changedFields.length)return false;
      if(isManualDecision(cached)){x.manualReview=true;return false;}
      const previousStatus=String(cached.validation_status||'').trim().toUpperCase();
      if(isPhoneOnlyEdit(x.changedFields)&&APPROVED_STATUSES.has(previousStatus)){x.reason='phone_edited';x.previousStatus=previousStatus;x.previousFingerprint=String(cached.source_fingerprint||'');return true;}
      x.reason='edited';x.previousStatus=String(cached.validation_status||'');x.previousFingerprint=String(cached.source_fingerprint||'');return true;
    });
  }
  return items.map(x=>({...x,reason:'all'}));
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

  console.log("[3/7] Reading cache metadata...");
  const cacheMap=await readCacheMetadataMap(sheets);
  console.log(`[INFO] Cache rows: ${cacheMap.size}`);

  console.log("[4/7] Establishing edit-detection baseline...");
  const items=prepareSourceItems(headers,dataRows);
  const baselines=items.filter(x=>{const c=cacheMap.get(x.sourceRowNumber);return c&&!c.source_fingerprint;}).map(x=>({sheetRowNumber:cacheMap.get(x.sourceRowNumber)._sheetRowNumber,fingerprint:x.source.sourceFingerprint}));
  const baselineCount=await writeSourceFingerprintBaselines(sheets,baselines);
  for(const x of items){const c=cacheMap.get(x.sourceRowNumber);if(c&&!c.source_fingerprint)c.source_fingerprint=x.source.sourceFingerprint;}
  console.log(`[INFO] Fingerprint baselines written: ${baselineCount}`);
  const existingMap=await readExistingCacheMap(sheets);
  const editDetection=String(process.env.EDIT_DETECTION_ENABLED||'true').toLowerCase()!=='false';
  let candidates=selectRowsToProcess(items,cacheMap,processMode,{editDetection});
  const manualChanges=items.filter(x=>x.manualReview);
  console.log(`[INFO] Edit detection: ${editDetection?'enabled':'disabled'}; edited rows selected: ${candidates.filter(x=>x.reason==='edited').length}; manual locks held: ${manualChanges.length}`);
  for(const x of manualChanges)console.log(`[REVIEW] Source row ${x.sourceRowNumber} changed but has a manual decision lock.`);

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
  let reviewRequiredCount = 0;
  let preservedStatusCount = 0;
  let phoneEditCount = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    const item = candidates[i];
    const source = item.source;

    if(item.reason==='phone_edited'){
      rows.push(applyPhoneOnlyEdit(cacheMap.get(item.sourceRowNumber),source,item));
      phoneEditCount++;
      console.log(`[INFO] Source row ${item.sourceRowNumber} phone fields updated; document approval preserved without OCR.`);
      continue;
    }

    const bestCandidate = await pickBestFileCandidate({
      drive,
      source
    });

    const output=buildRow(source,bestCandidate.fileMeta,bestCandidate.matches,bestCandidate.score,bestCandidate.ocrResult,bestCandidate.extractedSignals);
    if(item.reason==='edited')output.notes=[output.notes,'source_edit_detected=true',`changed_fields=${item.changedFields.join(',')}`,`previous_validation_status=${item.previousStatus}`,`previous_source_fingerprint=${item.previousFingerprint}`].filter(Boolean).join(' | ');
    const protectedResult=protectApprovedDecision(cacheMap.get(item.sourceRowNumber),output,item);
    rows.push(protectedResult.row);
    if(protectedResult.reviewRequired){
      reviewRequiredCount++;
      console.log(`[REVIEW] Source row ${item.sourceRowNumber} kept ${item.previousStatus}; automatic recheck returned ${output.validation_status}.`);
    }
    if(protectedResult.statusPreserved)preservedStatusCount++;

    if ((i + 1) % 10 === 0 || i + 1 === candidates.length) {
      console.log(
        `[INFO] Prepared ${i + 1}/${candidates.length} rows... best_file=${bestCandidate.fileMeta?.fileId || "none"} score=${bestCandidate.confidence}`
      );
    }
  }

  console.log("[6/7] Writing...");
  const result = await upsertRows(sheets, rows, existingMap);

  console.log("[7/7] Done.");
  console.log(`[INFO] Phone-only edits applied without OCR: ${phoneEditCount}`);
  console.log(`[INFO] Approval protection: statuses preserved=${preservedStatusCount}; manual reviews required=${reviewRequiredCount}`);
  console.log("[DONE]", result);
}

module.exports = { runWorker, readCacheMetadataMap, prepareSourceItems, selectRowsToProcess, protectApprovedDecision, applyPhoneOnlyEdit, isPhoneOnlyEdit };
