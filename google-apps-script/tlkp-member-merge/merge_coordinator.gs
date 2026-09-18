const MEMBER_MERGE_CONTROL_SHEET = "_member_merge_control";
const MEMBER_MERGE_CONTROL_HEADERS = [
  "requested_token",
  "requested_at",
  "completed_token",
  "completed_at",
  "active_token",
  "active_at",
  "last_result",
  "last_error"
];
const MEMBER_MERGE_RECOVERY_MS = 6 * 60 * 60 * 1000;

function ensureMemberMergeControlSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(MEMBER_MERGE_CONTROL_SHEET);
  if (!sheet) sheet = ss.insertSheet(MEMBER_MERGE_CONTROL_SHEET);

  const current = sheet.getRange(1, 1, 1, MEMBER_MERGE_CONTROL_HEADERS.length).getValues()[0];
  const headersMatch = MEMBER_MERGE_CONTROL_HEADERS.every(
    (header, index) => current[index] === header
  );
  if (!headersMatch) {
    sheet.getRange(1, 1, 1, MEMBER_MERGE_CONTROL_HEADERS.length)
      .setValues([MEMBER_MERGE_CONTROL_HEADERS]);
  }
  return sheet;
}

function readMemberMergeControl_(sheet) {
  const values = sheet.getRange(2, 1, 1, MEMBER_MERGE_CONTROL_HEADERS.length).getValues()[0];
  const control = {};
  MEMBER_MERGE_CONTROL_HEADERS.forEach((header, index) => {
    control[header] = values[index] || "";
  });
  return control;
}

function writeMemberMergeControl_(sheet, fields) {
  Object.keys(fields).forEach(key => {
    const index = MEMBER_MERGE_CONTROL_HEADERS.indexOf(key);
    if (index < 0) {
      throw new Error("Unknown member merge control field: " + key);
    }
    // Update only the requested field. Rewriting the complete control row could
    // erase a new request that arrives while a merge is running.
    sheet.getRange(2, index + 1).setValue(fields[key] || "");
  });
}

function memberMergeRecoveryDue_(completedAt, now) {
  if (!completedAt) return true;
  const completedTime = new Date(completedAt).getTime();
  if (!Number.isFinite(completedTime)) return true;
  return now.getTime() - completedTime >= MEMBER_MERGE_RECOVERY_MS;
}

function runCoordinatedMemberMerge_(options) {
  const opts = options || {};
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    return { ran: false, reason: "merge_already_running" };
  }

  let controlSheet;
  let activeToken = "";
  try {
    controlSheet = ensureMemberMergeControlSheet_();
    const control = readMemberMergeControl_(controlSheet);
    const now = new Date();
    const pending = Boolean(control.requested_token) &&
      control.requested_token !== control.completed_token;
    const recoveryDue = memberMergeRecoveryDue_(control.completed_at, now);

    if (!opts.force && !pending && !recoveryDue) {
      return { ran: false, reason: "no_pending_request" };
    }

    activeToken = control.requested_token ||
      ("recovery:" + now.toISOString());
    writeMemberMergeControl_(controlSheet, {
      active_token: activeToken,
      active_at: now,
      last_error: ""
    });

    const summary = runMergeMembers_();
    const finishedAt = new Date();
    writeMemberMergeControl_(controlSheet, {
      completed_token: control.requested_token || control.completed_token,
      completed_at: finishedAt,
      active_token: "",
      active_at: "",
      last_result: JSON.stringify({
        reason: opts.reason || "unspecified",
        masterCount: summary.masterCount,
        exceptionCount: summary.exceptionCount,
        completedAt: finishedAt.toISOString()
      }),
      last_error: ""
    });

    const latest = readMemberMergeControl_(controlSheet);
    return {
      ran: true,
      reason: opts.reason || "unspecified",
      summary: summary,
      anotherRequestPending:
        Boolean(latest.requested_token) &&
        latest.requested_token !== latest.completed_token
    };
  } catch (error) {
    if (controlSheet) {
      writeMemberMergeControl_(controlSheet, {
        active_token: "",
        active_at: "",
        last_error: String(error && error.stack ? error.stack : error)
      });
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}
