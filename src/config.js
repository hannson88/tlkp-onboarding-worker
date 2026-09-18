const path = require("path");

const config = {
  SHEET_ID: process.env.GOOGLE_SHEET_ID,
  SOURCE_SHEET_NAME: process.env.SOURCE_SHEET_NAME || "Form Responses 1",
  CACHE_SHEET_NAME: process.env.CACHE_SHEET_NAME || "verification_cache",
  MERGE_CONTROL_SHEET_NAME:
    process.env.MERGE_CONTROL_SHEET_NAME || "_member_merge_control",
  SERVICE_ACCOUNT_PATH: path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
};

module.exports = config;
