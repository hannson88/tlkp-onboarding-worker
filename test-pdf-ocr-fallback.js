require("dotenv").config();

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const vision = require("@google-cloud/vision");

const config = require("./src/config");
const {
  getDriveClient,
  getFileMetadata,
  downloadFileBuffer
} = require("./src/google/drive");

const execFileAsync = promisify(execFile);

let visionClient = null;

function getVisionClient() {
  if (!visionClient) {
    visionClient = new vision.ImageAnnotatorClient({
      keyFilename: config.SERVICE_ACCOUNT_PATH
    });
  }
  return visionClient;
}

async function ensurePdftoppmExists() {
  try {
    await execFileAsync("pdftoppm", ["-v"]);
  } catch (err) {
    throw new Error(
      "pdftoppm is not installed. Install poppler-utils first with: apt install poppler-utils"
    );
  }
}

async function renderPdfFirstPageToPng(pdfPath, outputBase) {
  await execFileAsync("pdftoppm", [
    "-png",
    "-f",
    "1",
    "-singlefile",
    "-r",
    "200",
    pdfPath,
    outputBase
  ]);

  const pngPath = `${outputBase}.png`;

  if (!fs.existsSync(pngPath)) {
    throw new Error(`Rendered PNG not found: ${pngPath}`);
  }

  return pngPath;
}

async function runImageOcr(imagePath) {
  const client = getVisionClient();
  const buffer = fs.readFileSync(imagePath);

  const [result] = await client.documentTextDetection({
    image: {
      content: buffer
    }
  });

  const text =
    result?.fullTextAnnotation?.text ||
    result?.textAnnotations?.[0]?.description ||
    "";

  return text;
}

async function main() {
  const fileId = process.argv[2] || process.env.FILE_ID;

  if (!fileId) {
    console.error("Usage: node test-pdf-ocr-fallback.js <GOOGLE_DRIVE_FILE_ID>");
    process.exit(1);
  }

  await ensurePdftoppmExists();

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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-ocr-fallback-"));
  const pdfPath = path.join(tmpDir, "input.pdf");
  const outputBase = path.join(tmpDir, "page1");

  fs.writeFileSync(pdfPath, buffer);

  console.log("\n=== TEMP PATHS ===");
  console.log(`tmpDir=${tmpDir}`);
  console.log(`pdfPath=${pdfPath}`);

  try {
    const pngPath = await renderPdfFirstPageToPng(pdfPath, outputBase);

    console.log("\n=== RENDERED IMAGE ===");
    console.log(`pngPath=${pngPath}`);
    console.log(`pngBytes=${fs.statSync(pngPath).size}`);

    const text = await runImageOcr(pngPath);

    console.log("\n=== OCR TEXT SUMMARY ===");
    console.log(`textLength=${text.length}`);

    console.log("\n=== OCR TEXT ===");
    console.log(text || "[EMPTY]");
  } finally {
    // Leave temp files in place for debugging by default.
    // Uncomment below if you want auto-cleanup later.
    //
    // fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
