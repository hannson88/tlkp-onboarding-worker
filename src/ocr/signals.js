function unique(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function getLines(text) {
  return String(text || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeDigits(input) {
  return String(input || "").replace(/\D/g, "");
}

function normalizePhone(input) {
  return normalizeDigits(input).slice(-8);
}

function normalizeEmail(input) {
  return String(input || "").trim().toLowerCase();
}

function normalizeName(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeVinRn(input) {
  const raw = String(input || "").toUpperCase().trim();

  if (!raw) return "";

  if (raw.startsWith("RN")) {
    const digits = normalizeDigits(raw);
    return digits ? `RN${digits}` : "";
  }

  return raw.replace(/[^A-HJ-NPR-Z0-9]/g, "");
}

function isLikelySingaporeMobile(num) {
  return /^[89]\d{7}$/.test(num);
}

function extractEmails(text) {
  const matches =
    String(text || "").match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) || [];
  return unique(matches.map((x) => normalizeEmail(x)));
}

function extractVinRn(text) {
  const results = new Set();
  const raw = String(text || "");

  const rnMatches = raw.match(/\bRN\s*[-: ]?\s*\d{6,}\b/gi) || [];
  for (const m of rnMatches) {
    const normalized = normalizeVinRn(m);
    if (normalized) {
      results.add(normalized);
    }
  }

  const vinMatches = raw.match(/\b[A-HJ-NPR-Z0-9]{17}\b/gi) || [];
  for (const m of vinMatches) {
    const normalized = normalizeVinRn(m);
    if (normalized) {
      results.add(normalized);
    }
  }

  return Array.from(results);
}

function extractDirectPhonesFromWholeText(text) {
  const matches = String(text || "").match(/\b[89]\d{7}\b/g) || [];
  return unique(matches.map((x) => normalizePhone(x)).filter(isLikelySingaporeMobile));
}

function extractPhonesFromSingleLine(line) {
  const candidates = [];
  const compact = normalizeDigits(line);

  if (isLikelySingaporeMobile(compact)) {
    candidates.push(compact);
  }

  const spaced = line.match(/\b([89]\d{3})\s+(\d{4})\b/g) || [];
  for (const s of spaced) {
    const digits = normalizePhone(s);
    if (isLikelySingaporeMobile(digits)) {
      candidates.push(digits);
    }
  }

  return unique(candidates);
}

function scorePhoneCandidate(candidate, line, idx, lines) {
  let score = 0;
  const lower = String(line || "").toLowerCase();

  if (isLikelySingaporeMobile(candidate)) score += 50;

  if (lower.includes("phone")) score += 20;
  if (lower.includes("mobile")) score += 20;
  if (lower.includes("contact")) score += 15;
  if (lower.includes("customer")) score += 10;

  if (/^\d{4}\s+\d{4}$/.test(line.trim())) score += 35;
  if (/^[89]\d{7}$/.test(line.trim())) score += 35;

  if (idx > 0) {
    const prev = String(lines[idx - 1] || "").toLowerCase();
    if (prev.includes("customer")) score += 20;
    if (prev.includes("singapore")) score += 5;
  }

  if (idx < lines.length - 1) {
    const next = String(lines[idx + 1] || "").toLowerCase();
    if (next.includes("@")) score += 20;
    if (next.includes("description")) score += 10;
  }

  return score;
}

function extractBestPhones(text) {
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

  const orderedPhones = [];
  const seen = new Set();

  for (const item of scored) {
    if (!seen.has(item.phone)) {
      seen.add(item.phone);
      orderedPhones.push(item.phone);
    }
  }

  return orderedPhones;
}

function extractSignalsFromText(text) {
  const rawText = String(text || "");
  const normalizedText = normalizeText(rawText);

  const phones = extractBestPhones(rawText);
  const emails = extractEmails(rawText);
  const vinRn = extractVinRn(rawText);

  return {
    rawText,
    normalizedText,
    phones,
    emails,
    vinRn
  };
}

module.exports = {
  extractSignalsFromText,
  normalizePhone,
  normalizeEmail,
  normalizeName,
  normalizeVinRn
};
