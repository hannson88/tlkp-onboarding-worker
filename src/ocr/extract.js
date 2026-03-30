const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const vision = require("@google-cloud/vision");
const { PDFParse } = require("pdf-parse");

const config = require("../config");
const { downloadFileBuffer } = require("../google/drive");
const { extractSignalsFromText } = require("./signals");

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

function hasUsefulIdentitySignals(text) {
  const signals = extractSignalsFromText(text || "");

  return (
    (signals.phones || []).length > 0 ||
    (signals.emails || []).length > 0 ||
    (signals.vinRn || []).length > 0
  );
}

async function ensurePdftoppmExists() {
  try {
    await execFileAsync("pdftoppm", ["-v"]);
  } catch (err) {
    throw new Error(
      "pdftoppm_not_installed: install poppler-utils with 'apt install poppler-utils'"
    );
  }
}

async function extractTextFromPdfBuffer(buffer) {
  const parser = new PDFParse({ data: buffer });

  try {
    await parser.load();
    const data = await parser.getText();
    const text = data?.text || "";

    return {
      ok: Boolean(text.trim()),
      text,
      reason: text.trim() ? "pdf_text_extract_ok" : "pdf_text_extract_empty"
    };
  } finally {
    try {
      await parser.destroy();
    } catch (e) {}
  }
}

async function extractTextFromImageBuffer(buffer) {
  const client = getVisionClient();

  const [result] = await client.documentTextDetection({
    image: {
      content: buffer
    }
  });

  const text =
    result.fullTextAnnotation?.text ||
    result.textAnnotations?.[0]?.description ||
    "";

  return {
    ok: Boolean(text.trim()),
    text: text || "",
    reason: text.trim() ? "image_ocr_ok" : "image_ocr_empty"
  };
}

async function renderPdfFirstPageToPng(buffer) {
  await ensurePdftoppmExists();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-ocr-fallback-"));
  const pdfPath = path.join(tmpDir, "input.pdf");
  const outputBase = path.join(tmpDir, "page1");
  const pngPath = `${outputBase}.png`;

  fs.writeFileSync(pdfPath, buffer);

  try {
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

    if (!fs.existsSync(pngPath)) {
      throw new Error(`rendered_png_not_found: ${pngPath}`);
    }

    return {
      tmpDir,
      pngPath,
      pngBuffer: fs.readFileSync(pngPath)
    };
  } catch (err) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
    throw err;
  }
}

async function extractTextFromPdfBufferWithFallback(buffer) {
  const direct = await extractTextFromPdfBuffer(buffer);

  const directHasUsefulSignals =
    direct.text && hasUsefulIdentitySignals(direct.text);

  if (direct.ok && directHasUsefulSignals) {
    return direct;
  }

  try {
    const rendered = await renderPdfFirstPageToPng(buffer);

    try {
      const fallback = await extractTextFromImageBuffer(rendered.pngBuffer);
      const fallbackHasUsefulSignals =
        fallback.text && hasUsefulIdentitySignals(fallback.text);

      if (fallback.ok && fallbackHasUsefulSignals) {
        return {
          ok: true,
          text: fallback.text,
          reason: "pdf_ocr_fallback_ok"
        };
      }

      if (direct.ok) {
        return {
          ok: direct.ok,
          text: direct.text,
          reason: directHasUsefulSignals
            ? direct.reason
            : "pdf_text_extract_weak_no_identity_signal"
        };
      }

      return {
        ok: fallback.ok,
        text: fallback.text,
        reason: fallback.ok
          ? "pdf_ocr_fallback_ok_but_weak"
          : "pdf_ocr_fallback_empty"
      };
    } finally {
      try {
        fs.rmSync(rendered.tmpDir, { recursive: true, force: true });
      } catch (e) {}
    }
  } catch (err) {
    if (direct.ok) {
      return {
        ok: direct.ok,
        text: direct.text,
        reason: directHasUsefulSignals
          ? direct.reason
          : "pdf_text_extract_weak_no_identity_signal"
      };
    }

    return {
      ok: false,
      text: "",
      reason: `pdf_ocr_fallback_failed: ${err.message}`
    };
  }
}

async function extractTextFromDriveFile(drive, fileMeta) {
  if (!fileMeta || !fileMeta.fileId) {
    return {
      ok: false,
      text: "",
      reason: "missing file id"
    };
  }

  if (fileMeta.fileType === "missing" || fileMeta.docClass === "DOC_REJECT") {
    return {
      ok: false,
      text: "",
      reason: fileMeta.reason || "unsupported file"
    };
  }

  if (fileMeta.fileType !== "image" && fileMeta.fileType !== "pdf") {
    return {
      ok: false,
      text: "",
      reason: "unsupported_file_type_for_ocr"
    };
  }

  try {
    const buffer = await downloadFileBuffer(drive, fileMeta.fileId);

    if (fileMeta.fileType === "pdf") {
      return await extractTextFromPdfBufferWithFallback(buffer);
    }

    if (fileMeta.fileType === "image") {
      return await extractTextFromImageBuffer(buffer);
    }

    return {
      ok: false,
      text: "",
      reason: "unsupported_file_type_for_ocr"
    };
  } catch (err) {
    return {
      ok: false,
      text: "",
      reason: `ocr_failed: ${err.message}`
    };
  }
}

module.exports = {
  extractTextFromDriveFile
};
