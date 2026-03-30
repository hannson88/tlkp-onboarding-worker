function normalizePhone(input) {
  const digits = String(input || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.slice(-8);
}

function normalizeHeader(header) {
  return String(header || "")
    .toLowerCase()
    .replace(/\n/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function hasAny(header, words) {
  return words.some((w) => header.includes(w));
}

function hasAll(header, words) {
  return words.every((w) => header.includes(w));
}

function looksLikeDriveLink(value) {
  const text = String(value || "");
  return text.includes("drive.google.com") || /[?&]id=[A-Za-z0-9_-]{10,}/.test(text);
}

function firstMatchingValue(headers, row, predicates) {
  for (let i = 0; i < headers.length; i += 1) {
    const rawHeader = headers[i];
    const normHeader = normalizeHeader(rawHeader);
    const value = String(row[i] || "").trim();

    if (!value) continue;

    for (const predicate of predicates) {
      if (predicate(normHeader, value, rawHeader, i)) {
        return value;
      }
    }
  }
  return "";
}

function parseDriveFileIds(raw) {
  const text = String(raw || "");
  if (!text.trim()) return [];

  const ids = new Set();

  const patterns = [
    /[?&]id=([A-Za-z0-9_-]{10,})/g,
    /\/file\/d\/([A-Za-z0-9_-]{10,})/g,
    /\/d\/([A-Za-z0-9_-]{10,})/g,
    /\b([A-Za-z0-9_-]{20,})\b/g
  ];

  for (const re of patterns) {
    let match;
    while ((match = re.exec(text)) !== null) {
      ids.add(match[1]);
    }
  }

  return Array.from(ids);
}

function extractSourceContext(headers, row, sourceRowNumber) {
  const timestamp = firstMatchingValue(headers, row, [
    (h) => h === "timestamp",
    (h) => h.includes("date submitted"),
    (h) => h.includes("submission")
  ]);

  const email = firstMatchingValue(headers, row, [
    (h) => h === "email",
    (h) => h.includes("email address"),
    (h) => h.includes("e mail"),
    (h) => h.includes("email")
  ]);

  const fullName = firstMatchingValue(headers, row, [
    (h) => h === "full name",
    (h) => hasAll(h, ["full", "name"]),
    (h) => hasAll(h, ["applicant", "name"]),
    (h) => hasAll(h, ["your", "name"]),
    (h) => h === "name"
  ]);

  const applicantPhoneRaw = firstMatchingValue(headers, row, [
    (h, v) =>
      hasAll(h, ["contact", "number"]) &&
      !h.includes("owner") &&
      !looksLikeDriveLink(v),
    (h, v) =>
      hasAll(h, ["phone", "number"]) &&
      !h.includes("owner") &&
      !looksLikeDriveLink(v),
    (h, v) =>
      hasAll(h, ["mobile", "number"]) &&
      !h.includes("owner") &&
      !looksLikeDriveLink(v),
    (h, v) =>
      h.includes("whatsapp") &&
      !h.includes("owner") &&
      !looksLikeDriveLink(v),
    (h, v) =>
      h === "contact number" &&
      !h.includes("owner") &&
      !looksLikeDriveLink(v),
    (h, v) =>
      h === "phone" &&
      !h.includes("owner") &&
      !looksLikeDriveLink(v),
    (h, v) =>
      h === "mobile" &&
      !h.includes("owner") &&
      !looksLikeDriveLink(v),
    (h, v) =>
      h === "original contact" &&
      !looksLikeDriveLink(v),
    (h, v) =>
      h === "cleaned primary" &&
      !looksLikeDriveLink(v)
  ]);

  const ownerPhoneRaw = firstMatchingValue(headers, row, [
    (h, v) =>
      hasAll(h, ["owner", "contact"]) &&
      !looksLikeDriveLink(v),
    (h, v) =>
      hasAll(h, ["owner", "phone"]) &&
      !looksLikeDriveLink(v),
    (h, v) =>
      hasAll(h, ["owner", "mobile"]) &&
      !looksLikeDriveLink(v),
    (h, v) =>
      h === "additional number" &&
      !looksLikeDriveLink(v)
  ]);

  const vinRn = firstMatchingValue(headers, row, [
    (h, v) =>
      (h === "vin" || hasAll(h, ["vin", "rn"]) || h.includes("vin rn")) &&
      !looksLikeDriveLink(v) &&
      !hasAny(h, ["upload", "file", "attachment", "document"]),
    (h, v) =>
      h.includes("chassis") &&
      !looksLikeDriveLink(v) &&
      !hasAny(h, ["upload", "file", "attachment", "document"]),
    (h, v) =>
      h.includes("reservation number") &&
      !looksLikeDriveLink(v) &&
      !hasAny(h, ["upload", "file", "attachment", "document"]),
    (h, v) =>
      h === "rn" &&
      !looksLikeDriveLink(v) &&
      !hasAny(h, ["upload", "file", "attachment", "document"])
  ]);

  const uploadLinksRaw = firstMatchingValue(headers, row, [
    (h, v) =>
      looksLikeDriveLink(v) &&
      hasAny(h, ["upload", "file", "attachment", "document"]),
    (_, v) => looksLikeDriveLink(v)
  ]);

  const additionalComments = firstMatchingValue(headers, row, [
    (h) => h.includes("additional comments"),
    (h) => h.includes("additional"),
    (h) => h.includes("remarks")
  ]);

  const otherComments = firstMatchingValue(headers, row, [
    (h) => h.includes("other comments"),
    (h) => h.includes("notes")
  ]);

  const phoneApplicantNorm = normalizePhone(applicantPhoneRaw);
  let phoneOwnerNorm = normalizePhone(ownerPhoneRaw);

  if (phoneOwnerNorm && phoneOwnerNorm === phoneApplicantNorm) {
    phoneOwnerNorm = "";
  }

  const fileIds = parseDriveFileIds(uploadLinksRaw);

  console.log("DEBUG EXTRACT:", {
    row: sourceRowNumber,
    phone_raw: applicantPhoneRaw,
    phone_norm: phoneApplicantNorm,
    email,
    fullName,
    vinRn
  });

  return {
    sourceRowNumber: String(sourceRowNumber),
    timestamp,
    email,
    fullName,
    phoneApplicantRaw: applicantPhoneRaw,
    phoneApplicantNorm,
    phoneOwnerRaw: ownerPhoneRaw,
    phoneOwnerNorm,
    vinRn,
    uploadLinksRaw,
    fileIds,
    fileCount: fileIds.length,
    bestFileId: fileIds[0] || "",
    additionalComments,
    otherComments
  };
}

function boolString(value) {
  return value ? "TRUE" : "FALSE";
}

function getConfidenceScore(score) {
  if (!score || typeof score !== "object") return "";
  if (score.confidenceScore !== undefined) return score.confidenceScore;
  if (score.confidence_score !== undefined) return score.confidence_score;
  if (score.score !== undefined) return score.score;
  return "";
}

function getValidationStatus(score) {
  if (!score || typeof score !== "object") return "DOC_REJECT";
  if (score.validationStatus) return score.validationStatus;
  if (score.validation_status) return score.validation_status;
  if (score.status) return score.status;
  return "DOC_REJECT";
}

function getValidationReason(score, ocrResult) {
  if (score && typeof score === "object") {
    if (score.validationReason) return score.validationReason;
    if (score.validation_reason) return score.validation_reason;
    if (score.reason) return score.reason;
  }

  if (ocrResult && ocrResult.reason) {
    return ocrResult.reason;
  }

  return "no validation reason";
}

function buildNotes(source, fileMeta, ocrResult, extractedSignals) {
  const parts = [];

  if (source.vinRn) {
    parts.push(`form_vin_rn=${source.vinRn}`);
  }

  if (source.additionalComments) {
    parts.push(`additional_comments=${source.additionalComments}`);
  }

  if (source.otherComments) {
    parts.push(`other_comments=${source.otherComments}`);
  }

  if (fileMeta && fileMeta.reason) {
    parts.push(`file_meta=${fileMeta.reason}`);
  }

  if (ocrResult && ocrResult.reason) {
    parts.push(`ocr=${ocrResult.reason}`);
  }

  const phones = unique(extractedSignals?.phones || []);
  const emails = unique(extractedSignals?.emails || []);
  const vinRn = unique(extractedSignals?.vinRn || []);

  if (phones.length > 0) {
    parts.push(`ocr_phones=${phones.join("|")}`);
  }

  if (emails.length > 0) {
    parts.push(`ocr_emails=${emails.join("|")}`);
  }

  if (vinRn.length > 0) {
    parts.push(`ocr_vin_rn=${vinRn.join("|")}`);
  }

  return parts.join(" | ");
}

function buildRow(source, fileMeta, matches, score, ocrResult, extractedSignals) {
  return {
    source_row_number: source.sourceRowNumber,
    timestamp: source.timestamp,
    email: source.email,
    full_name: source.fullName,
    phone_applicant_raw: source.phoneApplicantRaw,
    phone_applicant_norm: source.phoneApplicantNorm,
    phone_owner_raw: source.phoneOwnerRaw,
    phone_owner_norm: source.phoneOwnerNorm,
    upload_links_raw: source.uploadLinksRaw,
    file_count: source.fileCount,
    best_file_id: fileMeta?.fileId || source.bestFileId || "",
    best_file_type: fileMeta?.fileType || "",
    best_doc_class: fileMeta?.docClass || "",
    match_phone_applicant: boolString(matches?.matchPhoneApplicant),
    match_phone_owner: boolString(matches?.matchPhoneOwner),
    match_email: boolString(matches?.matchEmail),
    match_name: boolString(matches?.matchName),
    match_vin: boolString(matches?.matchVin),
    confidence_score: getConfidenceScore(score),
    validation_status: getValidationStatus(score),
    validation_reason: getValidationReason(score, ocrResult),
    processed_at: new Date().toISOString(),
    notes: buildNotes(source, fileMeta, ocrResult, extractedSignals)
  };
}

module.exports = {
  extractSourceContext,
  buildRow,
  normalizePhone
};
