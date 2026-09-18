'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const headers = [
  'requested_token',
  'requested_at',
  'completed_token',
  'completed_at',
  'active_token',
  'active_at',
  'last_result',
  'last_error'
];

function createHarness({ requested = '', completed = '', completedAt = '' } = {}) {
  const state = {
    headers: headers.slice(),
    row: [requested, '', completed, completedAt, '', '', '', ''],
    mergeCalls: 0,
    requestDuringMerge: ''
  };
  const sheet = {
    getRange(row, column, rowCount, columnCount) {
      return {
        getValues() {
          if (row === 1) return [state.headers.slice(0, columnCount)];
          return [state.row.slice(0, columnCount)];
        },
        setValues(values) {
          if (row === 1) state.headers = values[0].slice();
          else state.row = values[0].slice();
          return this;
        },
        setValue(value) {
          state.row[column - 1] = value;
          return this;
        }
      };
    }
  };
  const spreadsheet = {
    getSheetByName() { return sheet; },
    insertSheet() { return sheet; }
  };
  let lockAvailable = true;
  const context = {
    console,
    JSON,
    Date,
    Number,
    Boolean,
    String,
    Error,
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => lockAvailable,
        releaseLock: () => {}
      })
    },
    runMergeMembers_: () => {
      state.mergeCalls += 1;
      if (state.requestDuringMerge) state.row[0] = state.requestDuringMerge;
      return { masterCount: 4213, exceptionCount: 177 };
    }
  };
  vm.createContext(context);
  const source = fs.readFileSync(
    path.join(__dirname, 'google-apps-script/tlkp-member-merge/merge_coordinator.gs'),
    'utf8'
  );
  vm.runInContext(source, context);
  return {
    state,
    context,
    setLockAvailable(value) { lockAvailable = value; }
  };
}

{
  const h = createHarness({ requested: 'request-A' });
  h.state.requestDuringMerge = 'request-B';
  const first = h.context.runCoordinatedMemberMerge_({ force: false, reason: 'test' });
  assert.equal(first.ran, true);
  assert.equal(first.anotherRequestPending, true);
  assert.equal(h.state.row[0], 'request-B');
  assert.equal(h.state.row[2], 'request-A');

  h.state.requestDuringMerge = '';
  const second = h.context.runCoordinatedMemberMerge_({ force: false, reason: 'test' });
  assert.equal(second.ran, true);
  assert.equal(second.anotherRequestPending, false);
  assert.equal(h.state.row[2], 'request-B');

  const third = h.context.runCoordinatedMemberMerge_({ force: false, reason: 'test' });
  assert.equal(third.ran, false);
  assert.equal(third.reason, 'no_pending_request');
  assert.equal(h.state.mergeCalls, 2);
}

{
  const h = createHarness({ requested: 'request-A' });
  h.setLockAvailable(false);
  const result = h.context.runCoordinatedMemberMerge_({ force: false });
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'merge_already_running');
  assert.equal(h.state.mergeCalls, 0);
}

console.log('member merge coordinator tests passed');
