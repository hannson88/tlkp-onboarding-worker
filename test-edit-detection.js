'use strict';
require("dotenv").config();
const assert=require('node:assert/strict');
const {sourceFingerprint,changedFields,isManualDecision}=require('./src/cache/fingerprint');
const {selectRowsToProcess,protectApprovedDecision,applyPhoneOnlyEdit,isPhoneOnlyEdit}=require('./src/worker');
const fs=require('fs');const os=require('os');const path=require('path');
function source(overrides={}){return {fullName:'Ken Chan',email:'KEN@example.com',phoneApplicantNorm:'96805439',phoneOwnerNorm:'',vinRn:'5YJ3E1EA7KF000001',fileIds:['abcDEF_12345678901234567890'],...overrides};}
const a=source(),fp=sourceFingerprint(a);
assert.equal(fp,sourceFingerprint(source({fullName:'  ken   chan ',email:'ken@EXAMPLE.COM'})),'format-only edits must be ignored');
const cached={source_row_number:'2',full_name:'Ken Chan',email:'ken@example.com',phone_applicant_norm:'96805439',phone_owner_norm:'',upload_links_raw:'https://drive.google.com/file/d/abcDEF_12345678901234567890/view',notes:'form_vin_rn=5YJ3E1EA7KF000001',validation_status:'DOC_OK_HIGH',source_fingerprint:fp};
assert.deepEqual(changedFields(a,cached),[]);
const edited=source({phoneApplicantNorm:'91234567'});edited.sourceFingerprint=sourceFingerprint(edited);const item={sourceRowNumber:'2',source:edited,row:[]};
let selected=selectRowsToProcess([item],new Map([['2',{...cached}]]),'new_only');assert.equal(selected.length,1);assert.equal(selected[0].reason,'phone_edited');assert.deepEqual(selected[0].changedFields,['phoneApplicant']);
assert.equal(isPhoneOnlyEdit(selected[0].changedFields),true);
const phoneUpdated=applyPhoneOnlyEdit(cached,edited,selected[0]);
assert.equal(phoneUpdated.phone_applicant_norm,'91234567');
assert.equal(phoneUpdated.validation_status,'DOC_OK_HIGH','phone edits preserve the existing document approval');
assert.equal(phoneUpdated.source_fingerprint,sourceFingerprint(edited));
assert.match(phoneUpdated.notes,/contact_edit_applied=true/);
const locked={...cached,source_fingerprint:fp,notes:cached.notes+' | [manual-lock]'};selected=selectRowsToProcess([{sourceRowNumber:'2',source:edited,row:[]}],new Map([['2',locked]]),'new_only');assert.equal(selected.length,0);assert.equal(isManualDecision(locked),true);
selected=selectRowsToProcess([{sourceRowNumber:'3',source:a,row:[]}],new Map(),'new_only');assert.equal(selected.length,1);assert.equal(selected[0].reason,'new');
const baseline={...cached,source_fingerprint:''};selected=selectRowsToProcess([{sourceRowNumber:'2',source:a,row:[]}],new Map([['2',baseline]]),'new_only');assert.equal(selected.length,0,'uninitialized fingerprints are baselined, not replayed');

const editedItem={reason:'edited',changedFields:['phoneApplicant','fileIds']};
const rejectedOutput={...cached,phone_applicant_norm:'91234567',validation_status:'DOC_REJECT',validation_reason:'phone mismatch',source_fingerprint:'new-fingerprint',notes:'new OCR result'};
let protectedResult=protectApprovedDecision(cached,rejectedOutput,editedItem);
assert.equal(protectedResult.reviewRequired,true,'approved records must be held for review when an automatic rerun rejects');
assert.equal(protectedResult.row.validation_status,'DOC_OK_HIGH');
assert.equal(protectedResult.row.phone_applicant_norm,'96805439','unverified identity edits must not inherit an old approval');
assert.equal(protectedResult.row.source_fingerprint,'new-fingerprint','held edits must not rerun every five minutes');
assert.match(protectedResult.row.notes,/source_edit_review_required=true/);

const mediumOutput={...cached,phone_applicant_norm:'91234567',validation_status:'DOC_OK_MEDIUM',validation_reason:'medium match',source_fingerprint:'new-fingerprint',notes:'new OCR result'};
protectedResult=protectApprovedDecision(cached,mediumOutput,editedItem);
assert.equal(protectedResult.reviewRequired,false);
assert.equal(protectedResult.row.phone_applicant_norm,'91234567','verified identity edits may update cached identity fields');
assert.equal(protectedResult.row.validation_status,'DOC_OK_HIGH','automatic reruns must not lower an existing approval level');

const upgradedOutput={...cached,validation_status:'DOC_OK_HIGH',source_fingerprint:'new-fingerprint'};
protectedResult=protectApprovedDecision({...cached,validation_status:'DOC_OK_MEDIUM'},upgradedOutput,editedItem);
assert.equal(protectedResult.row.validation_status,'DOC_OK_HIGH','automatic upgrades remain allowed');

const priorReject={...cached,validation_status:'DOC_REJECT'};
protectedResult=protectApprovedDecision(priorReject,rejectedOutput,editedItem);
assert.equal(protectedResult.statusPreserved,false,'non-approved records continue through normal reprocessing');
selected=selectRowsToProcess([{sourceRowNumber:'2',source:edited,row:[]}],new Map([['2',priorReject]]),'new_only');
assert.equal(selected[0].reason,'edited','phone changes on unapproved records must rerun verification because the new phone may now match');
console.log('edit detection tests passed');
(function reviewHandoffTests(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tlkp-review-'));process.env.TLKP_VERIFICATION_REVIEW_ROOT=root;process.env.TLKP_VERIFICATION_REVIEW_ENABLED='true';process.env.TLKP_VERIFICATION_REVIEW_DECISIONS_ENABLED='true';
 delete require.cache[require.resolve('./src/review/handoff')];const handoff=require('./src/review/handoff');
 const reviewCase=handoff.buildReviewCase({item:{sourceRowNumber:'2',changedFields:['fullName'],previousFingerprint:'old'},cached,attempted:rejectedOutput});
 assert.equal(handoff.emitReviewCase(reviewCase),true);assert.equal(fs.existsSync(path.join(root,'inbox',`${reviewCase.id}.json`)),true);
 handoff.atomicJson(path.join(root,'decisions',`${reviewCase.id}.json`),{caseId:reviewCase.id,action:'approve_medium',adminId:'123',notes:'Identity confirmed',decidedAt:new Date().toISOString()});
 const decisionSource=source();decisionSource.sourceFingerprint='new-fingerprint';
 const decisions=handoff.loadDecisions({cacheMap:new Map([['2',{...cached,source_fingerprint:'new-fingerprint'}]]),sourceItems:[{sourceRowNumber:'2',source:decisionSource}]});
 assert.equal(decisions.length,1);assert.equal(decisions[0].error,'');assert.equal(decisions[0].row.validation_status,'DOC_OK_MEDIUM');assert.match(decisions[0].row.notes,/\[manual-lock\]/);
 handoff.finalizeDecisions(decisions);assert.equal(fs.existsSync(path.join(root,'receipts',`${reviewCase.id}.json`)),true);assert.equal(fs.readdirSync(path.join(root,'processed')).length,1);
 const oldCase={...reviewCase,id:'VR-2-OLDER',status:'open',sourceFingerprint:'older-fingerprint'};handoff.atomicJson(path.join(root,'cases',`${oldCase.id}.json`),oldCase);
 assert.equal(handoff.resolveCasesForSuccessfulEdit({reason:'edited',sourceRowNumber:'2'},{validation_status:'DOC_OK_HIGH',source_fingerprint:'latest-fingerprint'}),1);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'receipts',`${oldCase.id}.json`))).outcome,'superseded_by_verified_edit');
 fs.rmSync(root,{recursive:true,force:true});delete process.env.TLKP_VERIFICATION_REVIEW_ENABLED;delete process.env.TLKP_VERIFICATION_REVIEW_DECISIONS_ENABLED;delete process.env.TLKP_VERIFICATION_REVIEW_ROOT;
 console.log('review handoff tests passed');
})();
(async()=>{
 const {CACHE_HEADERS}=require('./src/cache/schema');
 const {writeSourceFingerprintBaselines,upsertRows}=require('./src/google/sheets');
 assert.equal(CACHE_HEADERS.at(-2),'test_batch');assert.equal(CACHE_HEADERS.at(-1),'source_fingerprint');
 const calls=[];const sheets={spreadsheets:{values:{batchUpdate:async x=>calls.push(x),append:async()=>{throw Error('unexpected append')}}}};
 await writeSourceFingerprintBaselines(sheets,[{sheetRowNumber:2,fingerprint:'abc'}]);
 assert.equal(calls[0].requestBody.data[0].range.endsWith('!Y2'),true);
 calls.length=0;await upsertRows(sheets,[{source_row_number:'2',notes:'new',source_fingerprint:'def'}],new Map([['2',2]]));
 const ranges=calls[0].requestBody.data.map(x=>x.range);assert.equal(ranges.some(x=>x.endsWith('!A2:W2')),true);assert.equal(ranges.some(x=>x.endsWith('!Y2')),true);assert.equal(ranges.some(x=>x.includes('X2')),false,'test_batch must remain untouched');
 console.log('sheet preservation tests passed');
})().catch(e=>{console.error(e);process.exit(1)});
