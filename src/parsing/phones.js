function extractAllPhones(input) {
  if (!input) return [];

  const text = String(input);
  const matches = text.match(/(?:\+65\s*)?[89]\d{3}\s*\d{4}/g);

  if (!matches) return [];

  const normalized = matches.map((m) =>
    m.replace(/\D/g, "").slice(-8)
  );

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

function resolvePhones(applicantRaw, ownerRawOriginal) {
  const applicantPhones = extractAllPhones(applicantRaw);
  const ownerPhones = extractAllPhones(cleanOwnerField(ownerRawOriginal));

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

  return { applicant, owner };
}

module.exports = {
  extractAllPhones,
  cleanOwnerField,
  resolvePhones
};
