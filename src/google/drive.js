const fs = require("fs");
const { google } = require("googleapis");
const config = require("../config");

async function getDriveClient() {
  const credentials = JSON.parse(
    fs.readFileSync(config.SERVICE_ACCOUNT_PATH, "utf8")
  );

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"]
  });

  const client = await auth.getClient();

  return google.drive({ version: "v3", auth: client });
}

async function getFileMetadata(drive, fileId) {
  if (!fileId) {
    return {
      found: false,
      fileId: "",
      name: "",
      mimeType: "",
      fileType: "missing",
      docClass: "DOC_REJECT",
      reason: "missing file id"
    };
  }

  try {
    const res = await drive.files.get({
      fileId,
      fields: "id,name,mimeType"
    });

    const name = res.data.name || "";
    const mimeType = res.data.mimeType || "";

    let fileType = "other";
    let docClass = "DOC_REJECT";
    let reason = "unsupported file type";

    if (mimeType === "application/pdf") {
      fileType = "pdf";
      docClass = "DOC_OK";
      reason = "pdf file";
    } else if (mimeType.startsWith("image/")) {
      fileType = "image";
      docClass = "DOC_OK";
      reason = "image file";
    }

    return {
      found: true,
      fileId,
      name,
      mimeType,
      fileType,
      docClass,
      reason
    };
  } catch (err) {
    return {
      found: false,
      fileId,
      name: "",
      mimeType: "",
      fileType: "missing",
      docClass: "DOC_REJECT",
      reason: `drive lookup failed: ${err.message}`
    };
  }
}

async function downloadFileBuffer(drive, fileId) {
  const res = await drive.files.get(
    {
      fileId,
      alt: "media"
    },
    {
      responseType: "arraybuffer"
    }
  );

  return Buffer.from(res.data);
}

module.exports = {
  getDriveClient,
  getFileMetadata,
  downloadFileBuffer
};
