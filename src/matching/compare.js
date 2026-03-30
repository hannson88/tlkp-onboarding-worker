function normalizePhone(phone) {
  if (!phone) return "";

  const digits = String(phone).replace(/\D/g, "");

  if (digits.length >= 8) {
    return digits.slice(-8);
  }

  return digits;
}

function extractPhonesFromText(text) {
  if (!text) return [];

  const matches = String(text).match(/\d{8,}/g) || [];
  return matches.map(normalizePhone).filter(Boolean);
}

function normalizeName(name) {
  if (!name) return "";

  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function pickBestPhone(source, extracted) {
  const formPhones = [
    ...(extractPhonesFromText(source.phoneApplicantRaw)),
    ...(extractPhonesFromText(source.phoneApplicantNorm)),
    ...(extractPhonesFromText(source.phoneOwnerRaw)),
    ...(extractPhonesFromText(source.phoneOwnerNorm))
  ].filter(Boolean);

  const ocrPhones = (extracted.phones || []).map(normalizePhone).filter(Boolean);

  for (const fp of formPhones) {
    if (ocrPhones.includes(fp)) {
      return {
        phone: fp,
        source: "form_matched"
      };
    }
  }

  if (formPhones.length > 0) {
    return {
      phone: formPhones[0],
      source: "form_unmatched"
    };
  }

  if (ocrPhones.length > 0) {
    return {
      phone: ocrPhones[0],
      source: "ocr"
    };
  }

  return {
    phone: "",
    source: "none"
  };
}

function compareSignals(source, extracted) {
  const result = {
    matchPhoneApplicant: false,
    matchPhoneOwner: false,
    matchEmail: false,
    matchName: false,
    matchVin: false,

    effectivePhone: "",
    phoneSource: "none"
  };

  // -------------------------
  // PHONE
  // -------------------------
  const bestPhone = pickBestPhone(source, extracted);
  result.effectivePhone = bestPhone.phone;
  result.phoneSource = bestPhone.source;

  const ocrPhones = (extracted.phones || []).map(normalizePhone).filter(Boolean);

  if (bestPhone.phone && ocrPhones.includes(bestPhone.phone)) {
    result.matchPhoneApplicant = true;
  }

  // owner phone exact match if present
  const ownerPhones = [
    ...(extractPhonesFromText(source.phoneOwnerRaw)),
    ...(extractPhonesFromText(source.phoneOwnerNorm))
  ].filter(Boolean);

  if (ownerPhones.length > 0 && ownerPhones.some((p) => ocrPhones.includes(p))) {
    result.matchPhoneOwner = true;
  }

  // -------------------------
  // EMAIL
  // -------------------------
  const sourceEmail = String(source.email || "").toLowerCase().trim();
  const ocrEmails = (extracted.emails || []).map((e) =>
    String(e).toLowerCase().trim()
  );

  if (sourceEmail && ocrEmails.includes(sourceEmail)) {
    result.matchEmail = true;
  }

  // -------------------------
  // NAME
  // -------------------------
  const sourceName = normalizeName(source.fullName);
  const ocrNames = (extracted.names || []).map(normalizeName);
  const rawTextNorm = normalizeName(extracted.rawText || "");

  if (
    sourceName &&
    (
      ocrNames.some((n) => n && (n.includes(sourceName) || sourceName.includes(n))) ||
      (rawTextNorm && rawTextNorm.includes(sourceName))
    )
  ) {
    result.matchName = true;
  }

  // -------------------------
  // VIN / RN
  // -------------------------
  const sourceVin = String(source.vinRn || "").toUpperCase().trim();
  const ocrVin = (extracted.vinRn || []).map((v) =>
    String(v).toUpperCase().trim()
  );

  if (sourceVin && ocrVin.includes(sourceVin)) {
    result.matchVin = true;
  }

  return result;
}

module.exports = {
  compareSignals
};
