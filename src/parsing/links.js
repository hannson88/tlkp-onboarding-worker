function splitUploadLinks(raw) {
  if (!raw) return [];

  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractDriveFileId(url) {
  if (!url) return "";

  const text = String(url).trim();

  const openIdMatch = text.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (openIdMatch) return openIdMatch[1];

  const fileMatch = text.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return fileMatch[1];

  return "";
}

module.exports = {
  splitUploadLinks,
  extractDriveFileId
};
