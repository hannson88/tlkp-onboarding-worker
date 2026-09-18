const RAKLET_ORGANIZATION_ID = "56dfc2a2-d458-40be-8f1b-65204dc8bfd2";
const DEFAULT_RAKLET_TAB_NAME = "raklet";
const TEST_RAKLET_TAB_NAME = "raklet_api_test";
const MAX_PAGES_PER_RUN = 40;
const NEXT_RUN_DELAY_MS = 5 * 60 * 1000;

function rakletStartSync() {
  setRakletTargetTab_(DEFAULT_RAKLET_TAB_NAME);
  rakletResetSync_();
  clearRakletTriggers_();
  rakletSyncTest();
}

function rakletStartSyncApiTest() {
  setRakletTargetTab_(TEST_RAKLET_TAB_NAME);
  rakletResetSync_();
  clearRakletTriggers_();
  rakletSyncTest();
}

function rakletSyncTest() {
  try {
    runRakletSyncBatch_();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);

    if (isRetryableSheetsError_(message)) {
      Logger.log(
        "Temporary spreadsheet error during Raklet sync: " +
          message +
          ". Scheduling retry in " +
          NEXT_RUN_DELAY_MS +
          " ms."
      );
      scheduleNextRun_();
      return;
    }

    throw error;
  }
}

function runRakletSyncBatch_() {
  const ss = openSpreadsheetWithRetry_();
  const targetTabName = getRakletTargetTab_();
  let sheet = ss.getSheetByName(targetTabName);

  if (!sheet) {
    sheet = ss.insertSheet(targetTabName);
  }

  const props = PropertiesService.getScriptProperties();
  let continuation = props.getProperty("raklet_continuation") || "0";
  let totalRowCount = parseInt(props.getProperty("raklet_total") || "0", 10);
  let writeRow = parseInt(props.getProperty("raklet_write_row") || "2", 10);
  let lastPageSignature = props.getProperty("raklet_last_page_signature") || "";

  if (continuation === "0") {
    sheet.clearContents();

    const headers = [
      "Profile - Full Name",
      "Primary Email Address",
      "Phone - Number[0]",
      "Phone - Number[1]",
      "Phone - Number[2]",
      "Phone - Number[3]",
      "Phone - Number[4]"
    ];

    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    writeRow = 2;
    props.setProperty("raklet_write_row", String(writeRow));
  }

  const token = getRakletToken();
  let pagesFetched = 0;
  let completed = false;

  while (pagesFetched < MAX_PAGES_PER_RUN) {
    const url =
      "https://api.raklet.com/organisations/" +
      RAKLET_ORGANIZATION_ID +
      "/contacts?offset=" +
      continuation;

    const response = fetchWithRetry_(url, token);
    const json = JSON.parse(response.getContentText());

    const wrapper = json.Data || {};
    const contacts = wrapper.Data || [];
    const paging = wrapper.Paging || {};

    if (!totalRowCount) {
      totalRowCount = paging.TotalRowCount || 0;
      props.setProperty("raklet_total", String(totalRowCount));
    }

    Logger.log("Raklet paging: " + JSON.stringify(paging));

    if (contacts.length === 0) {
      completed = true;
      break;
    }

    const pageSignature = buildRakletPageSignature_(contacts);
    if (pageSignature && pageSignature === lastPageSignature) {
      throw new Error(
        "Raklet returned the same page again for offset=" + continuation
      );
    }

    const rows = contacts.map(contact => {
      const attrs = contact.Attributes || {};
      const phones = contact.Phones || [];
      const emails = contact.Emails || [];

      const fullName =
        attrs.fullName ||
        ((attrs.firstName || "") + " " + (attrs.lastName || "")).trim();

      const email =
        attrs.emailAddress ||
        (emails[0] && emails[0].EmailAddress) ||
        "";

      const phoneCols = ["", "", "", "", ""];

      for (let i = 0; i < phones.length && i < 5; i++) {
        const p = phones[i];
        phoneCols[i] = "+" + p.CountryCode + p.Number;
      }

      return [
        fullName,
        email,
        phoneCols[0],
        phoneCols[1],
        phoneCols[2],
        phoneCols[3],
        phoneCols[4]
      ];
    });

    sheet.getRange(writeRow, 1, rows.length, 7).setValues(rows);

    const nextContinuation = extractRakletContinuation_(paging, continuation, contacts.length);

    writeRow += rows.length;
    pagesFetched++;

    props.setProperty("raklet_write_row", String(writeRow));
    props.setProperty("raklet_continuation", String(nextContinuation));
    props.setProperty("raklet_last_page_signature", pageSignature);
    continuation = String(nextContinuation);
    lastPageSignature = pageSignature;

    Logger.log(
      "Fetched " + rows.length +
      " rows, total written so far: " + (writeRow - 2) +
      ", total available: " + totalRowCount +
      ", next offset: " + continuation
    );

    if (totalRowCount && (writeRow - 2) >= totalRowCount) {
      completed = true;
      break;
    }

    Utilities.sleep(1200);
  }

  if (completed) {
    Logger.log("Completed full sync. Total rows written: " + (writeRow - 2));

    const shouldMerge = props.getProperty("raklet_merge_after_sync");

    rakletResetSync_();
    clearRakletTriggers_();
    clearRakletTargetTab_();

    if (shouldMerge === "true") {
      props.deleteProperty("raklet_merge_after_sync");
      Logger.log("Running mergeMembersTrigger() after sync...");
      mergeMembersTrigger();
    }
  } else {
    Logger.log("Paused sync. Scheduling next run...");
    scheduleNextRun_();
  }
}

function openSpreadsheetWithRetry_() {
  const maxAttempts = 3;
  const spreadsheetId = SpreadsheetApp.getActiveSpreadsheet().getId();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return SpreadsheetApp.openById(spreadsheetId);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);

      if (!isRetryableSheetsError_(message) || attempt === maxAttempts) {
        throw error;
      }

      const waitMs = attempt * 5000;
      Logger.log(
        "Spreadsheet access timed out. Waiting " +
          waitMs +
          " ms before retry..."
      );
      Utilities.sleep(waitMs);
    }
  }
}

function isRetryableSheetsError_(message) {
  return /Service( Spreadsheets)? timed out|Service timed out: Spreadsheets/i.test(message);
}

function fetchWithRetry_(url, token) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = UrlFetchApp.fetch(url, {
      method: "get",
      muteHttpExceptions: true,
      headers: {
        "accept": "application/json",
        "Authorization": "bearer " + token
      }
    });

    const code = response.getResponseCode();
    const body = response.getContentText();

    if (code === 200) {
      return response;
    }

    if (body.indexOf("Too many requests") !== -1) {
      const waitMs = attempt * 3000;
      Logger.log("Rate limited. Waiting " + waitMs + " ms before retry...");
      Utilities.sleep(waitMs);
      continue;
    }

    throw new Error("Contacts request failed: " + body);
  }

  throw new Error("Contacts request failed after repeated rate limiting.");
}

function scheduleNextRun_() {
  clearRakletTriggers_();

  ScriptApp.newTrigger("rakletSyncTest")
    .timeBased()
    .after(NEXT_RUN_DELAY_MS)
    .create();
}

function clearRakletTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();

  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === "rakletSyncTest") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function rakletResetSync_() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty("raklet_continuation");
  props.deleteProperty("raklet_total");
  props.deleteProperty("raklet_write_row");
  props.deleteProperty("raklet_last_page_signature");
}

function getRakletTargetTab_() {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty("raklet_target_tab") || DEFAULT_RAKLET_TAB_NAME;
}

function setRakletTargetTab_(tabName) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty("raklet_target_tab", tabName);
}

function clearRakletTargetTab_() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty("raklet_target_tab");
}

function extractRakletContinuation_(paging, currentContinuation, contactsLength) {
  const candidates = [
    paging.Continuation,
    paging.ContinuationToken,
    paging.NextContinuation,
    paging.NextContinuationToken,
    paging.Next,
    paging.NextToken,
    paging.nextContinuation,
    paging.nextContinuationToken,
    paging.next,
    paging.nextToken
  ];

  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && String(candidate) !== "") {
      return candidate;
    }
  }

  const numericCurrent = parseInt(currentContinuation || "0", 10);
  if (!Number.isNaN(numericCurrent)) {
    return numericCurrent + contactsLength;
  }

  return currentContinuation;
}

function buildRakletPageSignature_(contacts) {
  const first = contacts && contacts[0];
  if (!first) return "";

  const attrs = first.Attributes || {};
  const phones = first.Phones || [];
  const emails = first.Emails || [];

  return JSON.stringify({
    id: first.Id || first.ID || "",
    fullName: attrs.fullName || ((attrs.firstName || "") + " " + (attrs.lastName || "")).trim(),
    email:
      attrs.emailAddress ||
      (emails[0] && (emails[0].EmailAddress || emails[0].emailAddress)) ||
      "",
    phone:
      phones[0] ?
        "+" + (phones[0].CountryCode || phones[0].countryCode || "") +
        (phones[0].Number || phones[0].number || "")
      : ""
  });
}

function rakletStopSync() {
  clearRakletTriggers_();
  Logger.log("Raklet auto-sync trigger cleared.");
}
