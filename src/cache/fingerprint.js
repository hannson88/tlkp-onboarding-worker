'use strict';
const crypto=require('crypto');
function text(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');}
function email(value){return String(value||'').normalize('NFKC').trim().toLowerCase();}
function token(value){return String(value||'').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g,'');}
function files(values){return [...new Set((values||[]).map(x=>String(x||'').trim()).filter(Boolean))].sort();}
function canonicalSource(source){return {name:text(source.fullName),email:email(source.email),phoneApplicant:String(source.phoneApplicantNorm||''),phoneOwner:String(source.phoneOwnerNorm||''),vinRn:token(source.vinRn),fileIds:files(source.fileIds)};}
function sourceFingerprint(source){return crypto.createHash('sha256').update(JSON.stringify(canonicalSource(source))).digest('hex');}
function noteValue(notes,key){const m=String(notes||'').match(new RegExp(`(?:^| \\| )${key}=([^|]*)`));return m?m[1].trim():'';}
function canonicalCache(row){return {name:text(row.full_name),email:email(row.email),phoneApplicant:String(row.phone_applicant_norm||''),phoneOwner:String(row.phone_owner_norm||''),vinRn:token(noteValue(row.notes,'form_vin_rn')),fileIds:files(String(row.upload_links_raw||'').match(/[A-Za-z0-9_-]{20,}/g)||[])};}
function changedFields(source,row){const a=canonicalSource(source),b=canonicalCache(row);return Object.keys(a).filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k]));}
function isManualDecision(row){const status=String(row.validation_status||'').trim().toUpperCase(),notes=String(row.notes||'');return status.startsWith('MANUAL_')||/\[(?:manual-lock|manual-decision)\]|manual_(?:decision|override)=/i.test(notes);}
module.exports={canonicalSource,sourceFingerprint,changedFields,isManualDecision};
