function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("TLKP Tools")
    .addItem("Merge Members Now", "mergeMembers")
    .addItem("Raklet Sync", "rakletStartSync")
    .addItem("Raklet Sync to API Test Tab", "rakletSyncApiTestMenu")
    .addItem("Compare Raklet Tabs", "compareRakletTabs")
    .addItem("Raklet Sync + Merge", "rakletSyncAndMerge")
    .addToUi();
}

/**
 * Manual run from menu.
 * Safe to show UI alert here.
 */
function mergeMembers() {
  const result = runCoordinatedMemberMerge_({ force: true, reason: "manual" });
  if (!result.ran) {
    SpreadsheetApp.getUi().alert(
      "A member merge is already running. Please try again after it finishes."
    );
    return;
  }
  const summary = result.summary;

  SpreadsheetApp.getUi().alert(
    "Merge complete.\n" +
    "Master members: " + summary.masterCount + "\n" +
    "Exceptions: " + summary.exceptionCount
  );
}

/**
 * Time-driven trigger should call THIS function.
 * No UI calls here.
 */
function mergeMembersTrigger() {
  const result = runCoordinatedMemberMerge_({
    force: false,
    reason: "scheduled-request-check"
  });
  if (!result.ran) {
    console.log("mergeMembersTrigger skipped: " + result.reason);
    return;
  }
  const summary = result.summary;
  console.log(
    "mergeMembersTrigger complete. Master members=" +
      summary.masterCount +
      ", Exceptions=" +
      summary.exceptionCount
  );
}

/**
 * Shared merge engine.
 * No UI calls inside this function.
 */
function runMergeMembers_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const formSheet = ss.getSheetByName("Form Responses 1");
  const rakletSheet = ss.getSheetByName("raklet");
  let masterSheet = ss.getSheetByName("members_master");
  let exceptionsSheet = ss.getSheetByName("merge_exceptions");

  if (!formSheet) throw new Error('Missing sheet: "Form Responses 1"');
  if (!rakletSheet) throw new Error('Missing sheet: "raklet"');

  if (!masterSheet) masterSheet = ss.insertSheet("members_master");
  if (!exceptionsSheet) exceptionsSheet = ss.insertSheet("merge_exceptions");

  const masterHeaders = [
    "member_key",
    "member_name",
    "email",
    "mobile_raw",
    "mobile_normalized",
    "source_form",
    "source_raklet",
    "form_timestamp",
    "raklet_phone_used",
    "source_count",
    "preferred_source",
    "telegram_id",
    "telegram_username",
    "role",
    "notes"
  ];

  const exceptionHeaders = [
    "source",
    "row_number",
    "member_name",
    "email",
    "phone_raw",
    "reason",
    "logged_at"
  ];

  // Preserve manual/admin columns from existing master sheet
  const existingMasterData = masterSheet.getDataRange().getValues();
  const manualMap = new Map();

  if (existingMasterData.length > 1) {
    const existingHeaders = existingMasterData[0];
    const idxMobileNorm = existingHeaders.indexOf("mobile_normalized");
    const idxTelegramId = existingHeaders.indexOf("telegram_id");
    const idxTelegramUsername = existingHeaders.indexOf("telegram_username");
    const idxRole = existingHeaders.indexOf("role");
    const idxNotes = existingHeaders.indexOf("notes");

    for (let i = 1; i < existingMasterData.length; i++) {
      const row = existingMasterData[i];
      const key = row[idxMobileNorm];
      if (!key) continue;

      manualMap.set(key, {
        telegram_id: idxTelegramId >= 0 ? row[idxTelegramId] : "",
        telegram_username: idxTelegramUsername >= 0 ? row[idxTelegramUsername] : "",
        role: idxRole >= 0 ? row[idxRole] : "",
        notes: idxNotes >= 0 ? row[idxNotes] : ""
      });
    }
  }

  const merged = new Map();
  const exceptions = [exceptionHeaders];
  const now = new Date();

  // Read Form Responses 1
  const formData = formSheet.getDataRange().getValues();
  for (let i = 1; i < formData.length; i++) {
    const row = formData[i];
    const timestamp = row[0];
    const email = row[1];
    const fullName = row[2];
    const contactNumber = row[3];

    if (isEntireRowBlank(row)) continue;

    const parsed = extractSingaporeMobile(contactNumber);

    if (!parsed.normalized) {
      exceptions.push([
        "form",
        i + 1,
        fullName || "",
        email || "",
        contactNumber || "",
        parsed.reason || "invalid phone",
        now
      ]);
      continue;
    }

    upsertMergedRecord(merged, parsed.normalized, {
      member_name: fullName || "",
      email: email || "",
      mobile_raw: contactNumber || "",
      mobile_normalized: parsed.normalized,
      source_form: "Y",
      source_raklet: "",
      form_timestamp: timestamp || "",
      raklet_phone_used: "",
      source_count: 1,
      preferred_source: "form"
    });
  }

  // Read raklet
  const rakletData = rakletSheet.getDataRange().getValues();
  for (let i = 1; i < rakletData.length; i++) {
    const row = rakletData[i];
    const fullName = row[0];
    const email = row[1];
    const phoneColumns = row.slice(2, 7); // C:G

    if (isEntireRowBlank(row)) continue;

    let chosenRawPhone = "";
    let normalized = "";
    let chosenReason = "missing phone";

    for (const phone of phoneColumns) {
      const parsed = extractSingaporeMobile(phone);
      if (parsed.normalized) {
        chosenRawPhone = phone;
        normalized = parsed.normalized;
        chosenReason = "";
        break;
      } else if (phone && chosenReason === "missing phone") {
        chosenReason = parsed.reason || "invalid phone";
      }
    }

    if (!normalized) {
      const allPhones = phoneColumns.filter(v => v !== "").join(" | ");
      exceptions.push([
        "raklet",
        i + 1,
        fullName || "",
        email || "",
        allPhones || "",
        allPhones ? chosenReason || "no valid phone in C:G" : "missing phone",
        now
      ]);
      continue;
    }

    upsertMergedRecord(merged, normalized, {
      member_name: fullName || "",
      email: email || "",
      mobile_raw: chosenRawPhone || "",
      mobile_normalized: normalized,
      source_form: "",
      source_raklet: "Y",
      form_timestamp: "",
      raklet_phone_used: chosenRawPhone || "",
      source_count: 1,
      preferred_source: "raklet"
    });
  }

  // Build master output
  const output = [masterHeaders];
  const sortedKeys = Array.from(merged.keys()).sort();

  for (const key of sortedKeys) {
    const rec = merged.get(key);
    const manual = manualMap.get(key) || {
      telegram_id: "",
      telegram_username: "",
      role: "",
      notes: ""
    };

    output.push([
      "SG-" + rec.mobile_normalized.replace("+", ""),
      rec.member_name,
      rec.email,
      rec.mobile_raw,
      rec.mobile_normalized,
      rec.source_form,
      rec.source_raklet,
      rec.form_timestamp,
      rec.raklet_phone_used,
      rec.source_count,
      rec.preferred_source,
      manual.telegram_id,
      manual.telegram_username,
      manual.role,
      manual.notes
    ]);
  }

  masterSheet.clearContents();
  masterSheet.getRange(1, 1, output.length, output[0].length).setValues(output);
  masterSheet.setFrozenRows(1);

  exceptionsSheet.clearContents();
  exceptionsSheet.getRange(1, 1, exceptions.length, exceptions[0].length).setValues(exceptions);
  exceptionsSheet.setFrozenRows(1);

  return {
    masterCount: output.length - 1,
    exceptionCount: exceptions.length - 1
  };
}

function upsertMergedRecord(merged, normalized, incoming) {
  if (!merged.has(normalized)) {
    merged.set(normalized, incoming);
    return;
  }

  const rec = merged.get(normalized);

  rec.member_name = rec.member_name || incoming.member_name || "";
  rec.email = rec.email || incoming.email || "";
  rec.mobile_raw = rec.mobile_raw || incoming.mobile_raw || "";
  rec.form_timestamp = rec.form_timestamp || incoming.form_timestamp || "";
  rec.raklet_phone_used = rec.raklet_phone_used || incoming.raklet_phone_used || "";

  if (incoming.source_form === "Y") rec.source_form = "Y";
  if (incoming.source_raklet === "Y") rec.source_raklet = "Y";

  rec.source_count = countSources(rec.source_form, rec.source_raklet);
  rec.preferred_source = derivePreferredSource(rec.source_form, rec.source_raklet);
}

function isEntireRowBlank(row) {
  return row.every(cell => String(cell || "").trim() === "");
}

function extractSingaporeMobile(input) {
  if (input === null || input === undefined || input === "") {
    return { normalized: "", reason: "missing phone" };
  }

  let raw = String(input).trim();
  if (!raw) {
    return { normalized: "", reason: "missing phone" };
  }

  raw = raw.replace(/\.0$/, "");

  const candidates = raw.match(/\+?\d[\d\s()\/.-]*/g) || [];

  for (let candidate of candidates) {
    let s = candidate.replace(/[^\d+]/g, "");

    if (/^\+65[89]\d{7}$/.test(s)) {
      return { normalized: s, reason: "" };
    }

    if (/^65[89]\d{7}$/.test(s)) {
      return { normalized: "+" + s, reason: "" };
    }

    if (/^[89]\d{7}$/.test(s)) {
      return { normalized: "+65" + s, reason: "" };
    }
  }

  if (/\+\d+/.test(raw) && !/\+65/.test(raw)) {
    return { normalized: "", reason: "non-SG number" };
  }

  if (/[\/]|wife|husband|spouse|and/i.test(raw)) {
    return { normalized: "", reason: "multiple numbers in one field" };
  }

  return { normalized: "", reason: "invalid phone" };
}

function countSources(formFlag, rakletFlag) {
  let count = 0;
  if (formFlag === "Y") count++;
  if (rakletFlag === "Y") count++;
  return count;
}

function derivePreferredSource(formFlag, rakletFlag) {
  if (formFlag === "Y" && rakletFlag === "Y") return "both";
  if (formFlag === "Y") return "form";
  if (rakletFlag === "Y") return "raklet";
  return "";
}
