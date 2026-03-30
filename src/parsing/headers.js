function normalizeHeader(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildHeaderLookup(headers) {
  return headers.map((header, index) => ({
    raw: String(header || ""),
    normalized: normalizeHeader(header),
    index
  }));
}

function findHeaderIndex(headers, matcher) {
  const found = headers.find(matcher);
  return found ? found.index : -1;
}

module.exports = {
  normalizeHeader,
  buildHeaderLookup,
  findHeaderIndex
};
