const fs = require("fs");
const { google } = require("googleapis");
const config = require("../config");

async function getSheetsClient() {
  const credentials = JSON.parse(
    fs.readFileSync(config.SERVICE_ACCOUNT_PATH, "utf8")
  );

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  const client = await auth.getClient();

  return google.sheets({ version: "v4", auth: client });
}

module.exports = { getSheetsClient };
