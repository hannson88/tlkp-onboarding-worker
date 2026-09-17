'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENABLED = () => String(process.env.TLKP_VERIFICATION_REVIEW_ENABLED || 'false').toLowerCase() === 'true';
const DECISIONS_ENABLED = () => String(process.env.TLKP_VERIFICATION_REVIEW_DECISIONS_ENABLED || 'false').toLowerCase() === 'true';
const ROOT = () => path.resolve(process.env.TLKP_VERIFICATION_REVIEW_ROOT || '/mutable/tlkp-shared/verification-review');
const APPROVALS = new Set(['approve_medium', 'approve_high']);
const APPROVED_STATUSES = new Set(['DOC_OK_MEDIUM', 'DOC_OK_HIGH']);
const TERMINAL = new Set([...APPROVALS, 'clarification', 'dismiss']);

function directories() {
  const root = ROOT();
  return {
    root,
    cases: path.join(root, 'cases'),
    inbox: path.join(root, 'inbox'),
    decisions: path.join(root, 'decisions'),
    processed: path.join(root, 'processed'),
    receipts: path.join(root, 'receipts')
  };
}

function ensureDirectories() {
  const dirs = directories();
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  return dirs;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o640);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

function safeRead(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return { _readError: error.message }; }
}

function caseIdFor({ sourceRowNumber, sourceFingerprint }) {
  const digest = crypto.createHash('sha256').update(`${sourceRowNumber}:${sourceFingerprint}`).digest('hex').slice(0, 12).toUpperCase();
  return `VR-${sourceRowNumber}-${digest}`;
}

function buildReviewCase({ item, cached, attempted }) {
  const id = caseIdFor({ sourceRowNumber: item.sourceRowNumber, sourceFingerprint: attempted.source_fingerprint });
  return {
    version: 1,
    id,
    type: 'verification_edit_review',
    status: 'open',
    createdAt: new Date().toISOString(),
    sourceRowNumber: String(item.sourceRowNumber),
    sourceFingerprint: String(attempted.source_fingerprint || ''),
    previousFingerprint: String(item.previousFingerprint || cached.source_fingerprint || ''),
    changedFields: [...(item.changedFields || [])],
    previousStatus: String(cached.validation_status || ''),
    previousReason: String(cached.validation_reason || ''),
    attemptedStatus: String(attempted.validation_status || ''),
    attemptedReason: String(attempted.validation_reason || ''),
    candidateRow: { ...attempted },
    currentRow: Object.fromEntries(Object.entries(cached).filter(([key]) => key !== '_sheetRowNumber'))
  };
}

function emitReviewCase(reviewCase) {
  if (!ENABLED()) return false;
  const dirs = ensureDirectories();
  const caseFile = path.join(dirs.cases, `${reviewCase.id}.json`);
  if (!fs.existsSync(caseFile)) atomicJson(caseFile, reviewCase);
  const inboxFile = path.join(dirs.inbox, `${reviewCase.id}.json`);
  if (!fs.existsSync(inboxFile)) atomicJson(inboxFile, reviewCase);
  return true;
}

function resolveCasesForSuccessfulEdit(item, output) {
  if (!ENABLED() || item.reason !== 'edited' || !APPROVED_STATUSES.has(String(output.validation_status || '').toUpperCase())) return 0;
  const dirs = ensureDirectories();
  let resolved = 0;
  for (const name of fs.readdirSync(dirs.cases).filter(name => name.endsWith('.json'))) {
    const file = path.join(dirs.cases, name), reviewCase = safeRead(file);
    if (!reviewCase.id || reviewCase.type !== 'verification_edit_review' || !['open', 'decision_pending'].includes(reviewCase.status)) continue;
    if (String(reviewCase.sourceRowNumber) !== String(item.sourceRowNumber) || reviewCase.sourceFingerprint === output.source_fingerprint) continue;
    const now = new Date().toISOString(), receipt = { version: 1, caseId: reviewCase.id, outcome: 'superseded_by_verified_edit', error: '', action: 'automatic_success', adminId: '', notes: `A later edit passed as ${output.validation_status}.`, processedAt: now };
    atomicJson(path.join(dirs.receipts, `${reviewCase.id}.json`), receipt);
    atomicJson(file, { ...reviewCase, status: receipt.outcome, decision: receipt, updatedAt: now });
    resolved += 1;
  }
  return resolved;
}

function loadDecisions({ cacheMap, sourceItems }) {
  if (!ENABLED() || !DECISIONS_ENABLED()) return [];
  const dirs = ensureDirectories();
  const sourceMap = new Map(sourceItems.map(item => [String(item.sourceRowNumber), item]));
  const actions = [];
  for (const name of fs.readdirSync(dirs.decisions).filter(name => name.endsWith('.json')).sort()) {
    const file = path.join(dirs.decisions, name);
    const decision = safeRead(file);
    const reviewCase = decision.caseId ? safeRead(path.join(dirs.cases, `${decision.caseId}.json`)) : {};
    let error = decision._readError || reviewCase._readError || '';
    if (!TERMINAL.has(decision.action)) error ||= 'UNSUPPORTED_DECISION';
    if (!reviewCase.id || !['open', 'decision_pending'].includes(reviewCase.status)) error ||= 'CASE_NOT_OPEN';
    const source = sourceMap.get(String(reviewCase.sourceRowNumber));
    const cached = cacheMap.get(String(reviewCase.sourceRowNumber));
    if (!source || !cached) error ||= 'SOURCE_OR_CACHE_MISSING';
    if (source && source.source.sourceFingerprint !== reviewCase.sourceFingerprint) error ||= 'SOURCE_CHANGED_AFTER_REVIEW';
    if (cached && String(cached.source_fingerprint || '') !== reviewCase.sourceFingerprint) error ||= 'CACHE_CHANGED_AFTER_REVIEW';
    if (cached && String(cached.validation_status || '') !== reviewCase.previousStatus) error ||= 'DECISION_BASELINE_CHANGED';

    let row = null;
    if (!error && APPROVALS.has(decision.action)) {
      row = { ...reviewCase.candidateRow };
      row.validation_status = decision.action === 'approve_high' ? 'DOC_OK_HIGH' : 'DOC_OK_MEDIUM';
      row.validation_reason = `Manual review ${decision.action === 'approve_high' ? 'high' : 'medium'}: ${String(decision.notes || 'updated information approved')}`;
      row.notes = [row.notes, `review_case=${reviewCase.id}`, `review_decision=${decision.action}`, `review_admin=${String(decision.adminId || '')}`, `review_decided_at=${String(decision.decidedAt || new Date().toISOString())}`, '[manual-lock]'].filter(Boolean).join(' | ');
    }
    actions.push({ file, name, decision, reviewCase, row, error });
  }
  return actions;
}

function finalizeDecisions(actions) {
  if (!actions.length) return;
  const dirs = ensureDirectories();
  for (const action of actions) {
    const now = new Date().toISOString();
    const outcome = action.error ? 'rejected_stale_or_invalid' : action.decision.action === 'clarification' ? 'clarification_requested' : action.decision.action === 'dismiss' ? 'dismissed' : 'applied';
    const receipt = {
      version: 1,
      caseId: action.decision.caseId || action.reviewCase.id || path.basename(action.name, '.json'),
      outcome,
      error: action.error || '',
      action: action.decision.action || '',
      adminId: String(action.decision.adminId || ''),
      notes: String(action.decision.notes || ''),
      processedAt: now
    };
    atomicJson(path.join(dirs.receipts, `${receipt.caseId}.json`), receipt);
    if (!action.error && action.reviewCase.id) {
      atomicJson(path.join(dirs.cases, `${action.reviewCase.id}.json`), { ...action.reviewCase, status: outcome, decision: receipt, updatedAt: now });
    }
    fs.renameSync(action.file, path.join(dirs.processed, `${path.basename(action.name, '.json')}.${Date.now()}.json`));
  }
}

module.exports = {
  enabled: ENABLED,
  decisionsEnabled: DECISIONS_ENABLED,
  directories,
  atomicJson,
  caseIdFor,
  buildReviewCase,
  emitReviewCase,
  resolveCasesForSuccessfulEdit,
  loadDecisions,
  finalizeDecisions
};
