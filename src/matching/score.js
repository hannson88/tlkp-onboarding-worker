function scoreValidation(source, fileMeta, ocrResult, matches) {
  const reasons = [];
  let confidence = 0;

  if (!fileMeta || fileMeta.docClass === "DOC_REJECT") {
    return {
      confidenceScore: "",
      validationStatus: "DOC_REJECT",
      validationReason: fileMeta?.reason || "unsupported document"
    };
  }

  if (!source.phoneApplicantNorm && !source.phoneOwnerNorm) {
    return {
      confidenceScore: "",
      validationStatus: "DOC_REJECT",
      validationReason: "missing contact number in form"
    };
  }

  if (!ocrResult.ok) {
    if (fileMeta.fileType === "pdf" && ocrResult.reason === "pdf_ocr_not_enabled_yet") {
      return {
        confidenceScore: "",
        validationStatus: "DOC_REVIEW",
        validationReason: "pdf queued for manual review until pdf ocr is enabled"
      };
    }

    return {
      confidenceScore: "",
      validationStatus: "OCR_FAILED",
      validationReason: ocrResult.reason || "ocr failed"
    };
  }

  if (matches.matchPhoneApplicant) {
    confidence += 50;
    reasons.push("applicant phone matched");
  }

  if (matches.matchPhoneOwner) {
    confidence += 35;
    reasons.push("owner phone matched");
  }

  if (matches.matchEmail) {
    confidence += 25;
    reasons.push("email matched");
  }

  if (matches.matchVin) {
    confidence += 30;
    reasons.push("vin/rn matched");
  }

  if (matches.matchName) {
    confidence += 10;
    reasons.push("name matched");
  }

  const hasPhoneMatch = matches.matchPhoneApplicant || matches.matchPhoneOwner;
  const hasStrongId = matches.matchVin;
  const hasSoftId = matches.matchEmail || matches.matchName;

  // Strongest path: VIN/RN is accepted as strong proof, just like VIN.
  // If VIN/RN matches and at least one other signal matches, accept.
  if (hasStrongId && (hasSoftId || hasPhoneMatch)) {
    return {
      confidenceScore: String(confidence),
      validationStatus: "DOC_OK_HIGH",
      validationReason: reasons.join("; ")
    };
  }

  // Phone + another signal is also strong.
  if (matches.matchPhoneApplicant && (matches.matchEmail || matches.matchName)) {
    return {
      confidenceScore: String(confidence),
      validationStatus: confidence >= 80 ? "DOC_OK_HIGH" : "DOC_OK_MEDIUM",
      validationReason: reasons.join("; ")
    };
  }

  // Owner phone path stays more cautious.
  if (matches.matchPhoneOwner && (matches.matchEmail || matches.matchName || matches.matchVin)) {
    return {
      confidenceScore: String(confidence),
      validationStatus: "DOC_REVIEW",
      validationReason: `owner-path match; ${reasons.join("; ")}`
    };
  }

  // Phone only is not enough for auto-approval, but worth review.
  if (hasPhoneMatch) {
    return {
      confidenceScore: String(confidence),
      validationStatus: "DOC_REVIEW",
      validationReason: `phone matched but supporting signals are weak; ${reasons.join("; ")}`
    };
  }

  // If VIN/RN matched but no phone matched, this is still acceptable for TLKP
  // because RN is as strong as VIN for your use case.
  if (hasStrongId) {
    if (hasSoftId) {
      return {
        confidenceScore: String(confidence),
        validationStatus: "DOC_OK_HIGH",
        validationReason: reasons.join("; ")
      };
    }

    return {
      confidenceScore: String(confidence),
      validationStatus: "DOC_OK_MEDIUM",
      validationReason: `vin/rn matched; phone not found clearly in document`
    };
  }

  // Email + name without VIN/RN is weaker; keep for review, not reject.
  if (matches.matchEmail && matches.matchName) {
    return {
      confidenceScore: String(confidence),
      validationStatus: "DOC_OK_MEDIUM",
      validationReason: reasons.join("; ")
    };
  }

  if (hasSoftId) {
    return {
      confidenceScore: String(confidence || ""),
      validationStatus: "DOC_REVIEW",
      validationReason: `document signals present but applicant phone not found; ${reasons.join("; ")}`
    };
  }

  return {
    confidenceScore: String(confidence || ""),
    validationStatus: "DOC_REJECT",
    validationReason: "no reliable identity signal matched"
  };
}

module.exports = {
  scoreValidation
};
