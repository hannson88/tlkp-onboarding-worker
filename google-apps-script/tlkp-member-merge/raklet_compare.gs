function compareRakletTabs() {
  const summary = runCompareRakletTabs_();

  SpreadsheetApp.getUi().alert(
    "Raklet compare complete.\n" +
    "Only in raklet: " + summary.onlyInRaklet + "\n" +
    "Only in raklet_api_test: " + summary.onlyInApiTest + "\n" +
    "Different details: " + summary.different + "\n" +
    'Output tab: "raklet_compare"'
  );
}

function runCompareRakletTabs_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rakletSheet = ss.getSheetByName("raklet");
  const apiTestSheet = ss.getSheetByName("raklet_api_test");
  let compareSheet = ss.getSheetByName("raklet_compare");

  if (!rakletSheet) throw new Error('Missing sheet: "raklet"');
  if (!apiTestSheet) throw new Error('Missing sheet: "raklet_api_test"');
  if (!compareSheet) compareSheet = ss.insertSheet("raklet_compare");

  const headers = [
    "status",
    "compare_key",
    "difference_summary",
    "raklet_row",
    "raklet_name",
    "raklet_email",
    "raklet_phones",
    "raklet_normalized_phones",
    "raklet_api_test_row",
    "raklet_api_test_name",
    "raklet_api_test_email",
    "raklet_api_test_phones",
    "raklet_api_test_normalized_phones"
  ];

  const rakletRecords = loadRakletCompareRecords_(rakletSheet);
  const apiTestRecords = loadRakletCompareRecords_(apiTestSheet);

  const rakletMap = groupRakletRecordsByKey_(rakletRecords);
  const apiTestMap = groupRakletRecordsByKey_(apiTestRecords);
  const keys = Array.from(new Set([...rakletMap.keys(), ...apiTestMap.keys()])).sort();

  const output = [headers];
  let onlyInRaklet = 0;
  let onlyInApiTest = 0;
  let different = 0;

  for (const key of keys) {
    const left = sortRakletCompareGroup_(rakletMap.get(key) || []);
    const right = sortRakletCompareGroup_(apiTestMap.get(key) || []);
    const maxLen = Math.max(left.length, right.length);

    for (let i = 0; i < maxLen; i++) {
      const l = left[i] || null;
      const r = right[i] || null;

      if (l && !r) {
        onlyInRaklet++;
        output.push(buildRakletCompareRow_("only_in_raklet", key, "Missing from raklet_api_test", l, null));
        continue;
      }

      if (!l && r) {
        onlyInApiTest++;
        output.push(buildRakletCompareRow_("only_in_raklet_api_test", key, "Missing from raklet", null, r));
        continue;
      }

      const diffSummary = summarizeRakletRecordDifference_(l, r);
      if (diffSummary) {
        different++;
        output.push(buildRakletCompareRow_("different", key, diffSummary, l, r));
      }
    }
  }

  compareSheet.clearContents();
  compareSheet.getRange(1, 1, output.length, output[0].length).setValues(output);
  compareSheet.setFrozenRows(1);

  return {
    onlyInRaklet: onlyInRaklet,
    onlyInApiTest: onlyInApiTest,
    different: different
  };
}

function loadRakletCompareRecords_(sheet) {
  const data = sheet.getDataRange().getValues();
  const records = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (isEntireRowBlank(row)) continue;

    const name = String(row[0] || "").trim();
    const email = String(row[1] || "").trim().toLowerCase();
    const phones = row.slice(2, 7)
      .map(value => String(value || "").trim())
      .filter(Boolean);

    records.push({
      rowNumber: i + 1,
      name: name,
      normalizedName: normalizeCompareText_(name),
      email: email,
      phones: phones,
      normalizedPhones: normalizeRakletPhonesForCompare_(phones),
      compareKey: buildRakletCompareKey_(name, email, phones)
    });
  }

  return records;
}

function groupRakletRecordsByKey_(records) {
  const grouped = new Map();

  records.forEach(record => {
    if (!grouped.has(record.compareKey)) {
      grouped.set(record.compareKey, []);
    }

    grouped.get(record.compareKey).push(record);
  });

  return grouped;
}

function sortRakletCompareGroup_(records) {
  return records.slice().sort((a, b) => {
    const aFingerprint = rakletCompareFingerprint_(a);
    const bFingerprint = rakletCompareFingerprint_(b);
    return aFingerprint.localeCompare(bFingerprint);
  });
}

function buildRakletCompareKey_(name, email, phones) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (normalizedEmail) return "email:" + normalizedEmail;

  const normalizedPhones = normalizeRakletPhonesForCompare_(phones);
  if (normalizedPhones.length) return "phone:" + normalizedPhones.join("|");

  return "name:" + normalizeCompareText_(name);
}

function normalizeRakletPhonesForCompare_(phones) {
  const normalized = [];

  (phones || []).forEach(phone => {
    const raw = String(phone || "").trim();
    if (!raw) return;

    const parsed = extractSingaporeMobile(raw);
    if (parsed.normalized) {
      normalized.push(parsed.normalized);
      return;
    }

    normalized.push(raw.replace(/\s+/g, " "));
  });

  return Array.from(new Set(normalized)).sort();
}

function normalizeCompareText_(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function rakletCompareFingerprint_(record) {
  return JSON.stringify([
    record.normalizedName,
    record.email,
    record.normalizedPhones.join("|"),
    record.phones.join("|")
  ]);
}

function summarizeRakletRecordDifference_(left, right) {
  const diffs = [];

  if (left.normalizedName !== right.normalizedName) diffs.push("name");
  if (left.email !== right.email) diffs.push("email");

  const leftPhones = left.normalizedPhones.join("|");
  const rightPhones = right.normalizedPhones.join("|");
  if (leftPhones !== rightPhones) diffs.push("phones");

  return diffs.join(", ");
}

function buildRakletCompareRow_(status, key, diffSummary, left, right) {
  return [
    status,
    key,
    diffSummary,
    left ? left.rowNumber : "",
    left ? left.name : "",
    left ? left.email : "",
    left ? left.phones.join(" | ") : "",
    left ? left.normalizedPhones.join(" | ") : "",
    right ? right.rowNumber : "",
    right ? right.name : "",
    right ? right.email : "",
    right ? right.phones.join(" | ") : "",
    right ? right.normalizedPhones.join(" | ") : ""
  ];
}
