'use strict';

const assert = require('node:assert/strict');
const {
  requestMemberMerge,
  MERGE_CONTROL_HEADERS
} = require('./src/google/sheets');

(async () => {
  const calls = { add: [], header: [], batch: [] };
  const sheets = {
    spreadsheets: {
      get: async () => ({ data: { sheets: [] } }),
      batchUpdate: async (request) => calls.add.push(request),
      values: {
        get: async () => ({ data: { values: [] } }),
        update: async (request) => calls.header.push(request),
        batchUpdate: async (request) => calls.batch.push(request)
      }
    }
  };

  const result = await requestMemberMerge(sheets, {
    reason: 'verification_cache_changed',
    changedRows: 2,
    processMode: 'new_only'
  });

  assert.match(result.requestedToken, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(calls.add.length, 1);
  assert.equal(calls.header.length, 1);
  assert.deepEqual(calls.header[0].requestBody.values[0], MERGE_CONTROL_HEADERS);
  assert.equal(calls.batch.length, 1);
  const data = calls.batch[0].requestBody.data;
  assert.equal(data[0].range.endsWith('!A2:B2'), true);
  assert.equal(data[0].values[0][0], result.requestedToken);
  assert.equal(data[1].range.endsWith('!G2'), true);
  assert.match(data[1].values[0][0], /"changedRows":2/);

  console.log('member merge request tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
