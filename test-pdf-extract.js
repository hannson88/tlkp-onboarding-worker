require("dotenv").config();

const {
  getDriveClient,
  getFileMetadata,
  downloadFileBuffer
} = require("./src/google/drive");

const { PDFParse } = require("pdf-parse");

async function main() {
  const fileId = process.argv[2] || process.env.FILE_ID;

  if (!fileId) {
    console.error("Usage: node test-pdf-extract.js <GOOGLE_DRIVE_FILE_ID>");
    process.exit(1);
  }

  const drive = await getDriveClient();
  const fileMeta = await getFileMetadata(drive, fileId);

  console.log("\n=== FILE METADATA ===");
  console.dir(fileMeta, { depth: null });

  if (!fileMeta.found) {
    throw new Error("File not found");
  }

  if (fileMeta.fileType !== "pdf") {
    throw new Error(`File is not detected as pdf. mimeType=${fileMeta.mimeType}`);
  }

  const buffer = await downloadFileBuffer(drive, fileId);

  console.log("\n=== PDF BUFFER ===");
  console.log(`bytes=${buffer.length}`);

  const parser = new PDFParse({ data: buffer });

  try {
    await parser.load();
    const data = await parser.getText();

    console.log("\n=== PDF TEXT SUMMARY ===");
    console.log(`pages=${data?.total ?? data?.numpages ?? "unknown"}`);
    console.log(`textLength=${(data?.text || "").length}`);

    console.log("\n=== PDF TEXT ===");
    console.log(data?.text || "[EMPTY]");
  } finally {
    await parser.destroy();
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
