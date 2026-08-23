import {
  HttpError, OCP_QUERY_BODY_FIELDS, OCP_RESOLVE_BODY_FIELDS, ROUTE_METHODS, assertNoPollutedKeys,
  rejectUnknownFields, requireEntryId, toResolveStatus,
  validateQueryPack, validateResolvePack, validateResolveMode, validateResponseMode,
  validateResolvePurpose, validateRequestedFields, validateLiveCheck,
} from './server.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok  ', name); pass++; }
  catch (e) { console.log('  FAIL', name, '->', e.message); fail++; }
}
function throws(fn, code) {
  try { fn(); } catch (e) {
    if (!(e instanceof HttpError)) throw new Error('not HttpError: ' + e.message);
    if (code && e.code !== code) throw new Error(`code ${e.code} != ${code}`);
    return;
  }
  throw new Error('expected throw');
}
function eq(a, b) { if (a !== b) throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

console.log('query_pack');
t('required rejects missing', () => throws(() => validateQueryPack(undefined, {required:true}), 'missing_query_pack'));
t('required rejects empty string', () => throws(() => validateQueryPack('', {required:true}), 'missing_query_pack'));
t('rejects bogus', () => throws(() => validateQueryPack('nope.v1', {required:true}), 'unsupported_query_pack'));
t('rejects non-string', () => throws(() => validateQueryPack(42, {required:true}), 'unsupported_query_pack'));
t('accepts valid', () => eq(validateQueryPack('ocp.query.keyword.v1', {required:true}), 'ocp.query.keyword.v1'));
t('optional defaults', () => eq(validateQueryPack(undefined), 'ocp.query.product-eval.v1'));

console.log('unknown fields');
t('rejects unknown', () => throws(() => rejectUnknownFields({query:'a', evil:1}, OCP_QUERY_BODY_FIELDS, 'req'), 'unsupported_field'));
t('allows known', () => rejectUnknownFields({query:'a', query_pack:'x', query_mode:'y', limit:1}, OCP_QUERY_BODY_FIELDS, 'req'));
t('lists unsupported', () => {
  try { rejectUnknownFields({aa:1, bb:2}, OCP_QUERY_BODY_FIELDS, 'req'); }
  catch (e) { eq(JSON.stringify(e.details.unsupported), '["aa","bb"]'); return; }
  throw new Error('no throw');
});

console.log('proto pollution');
t('rejects __proto__ key', () => throws(() => assertNoPollutedKeys(JSON.parse('{"__proto__":{"a":1}}')), 'invalid_request'));
t('rejects nested constructor', () => throws(() => assertNoPollutedKeys(JSON.parse('{"a":{"constructor":1}}')), 'invalid_request'));
t('rejects in array', () => throws(() => assertNoPollutedKeys(JSON.parse('[{"prototype":1}]')), 'invalid_request'));
t('allows clean', () => assertNoPollutedKeys({a:{b:[1,2,{c:3}]}}));

console.log('entry_id');
t('rejects number', () => throws(() => requireEntryId(12345), 'invalid_entry_id'));
t('rejects array', () => throws(() => requireEntryId(['a']), 'invalid_entry_id'));
t('rejects empty', () => throws(() => requireEntryId('   '), 'invalid_entry_id'));
t('rejects overlong', () => throws(() => requireEntryId('x'.repeat(129)), 'invalid_entry_id'));
t('trims', () => eq(requireEntryId('  prd_1  '), 'prd_1'));

console.log('resolve pack/mode/response_mode');
t('pack defaults', () => eq(validateResolvePack(undefined), 'ocp.resolve.product.v1'));
t('pack accepts alias', () => eq(validateResolvePack('ocp.resolve.product-eval.v1'), 'ocp.resolve.product-eval.v1'));
t('pack rejects bogus', () => throws(() => validateResolvePack('bogus'), 'unsupported_resolve_pack'));
t('mode defaults exact', () => eq(validateResolveMode(undefined), 'exact'));
t('mode accepts live', () => eq(validateResolveMode('live'), 'live'));
t('mode rejects bogus', () => throws(() => validateResolveMode('semantic'), 'unsupported_resolve_mode'));
t('response_mode defaults full', () => eq(validateResponseMode(undefined), 'full'));
t('response_mode status', () => eq(validateResponseMode('status'), 'status'));
t('response_mode rejects bogus', () => throws(() => validateResponseMode('brief'), 'unsupported_response_mode'));

console.log('toResolveStatus');
t('projects compact success', () => {
  const full = {
    id:'res_1', catalog_id:'cat', snapshotId:'s1', catalogVersion:'cv',
    query_pack:'ocp.resolve.product.v1', query_mode:'exact',
    entry_id:'prd_1', object_type:'ocp.commerce.product',
    visible_attributes:{product:{secret:1}},
    live_checks:[{check_id:'a',status:'passed'},{check_id:'b',status:'passed'}],
    freshness:{resolved_at:'T'}, expires_at:'E',
  };
  const s = toResolveStatus(full);
  eq(s.kind,'ResolveResult'); eq(s.status,'success'); eq(s.resolved,true);
  eq(s.checks_passed,true); eq(s.response_mode,'status');
  eq(s.visible_attributes, undefined);
  if (JSON.stringify(s).includes('secret')) throw new Error('leaked product payload');
});
t('checks_passed false when a check fails', () => {
  const s = toResolveStatus({
    id:'r',catalog_id:'c',snapshotId:'s',catalogVersion:'v',
    query_pack:'p',query_mode:'exact',entry_id:'e',object_type:'t',
    live_checks:[{check_id:'a',status:'passed'},{check_id:'b',status:'failed'}],
    freshness:{resolved_at:'T'},expires_at:'E',
  });
  eq(s.checks_passed,false);
});

console.log('ocp-cli spec envelope fields accepted');
for (const f of ['ocp_version','kind','explain','offset']) {
  t(`query allows ${f}`, () => rejectUnknownFields({[f]:1}, OCP_QUERY_BODY_FIELDS, 'req'));
}
for (const f of ['ocp_version','kind','purpose','live_check','requested_fields']) {
  t(`resolve allows ${f}`, () => rejectUnknownFields({[f]:1}, OCP_RESOLVE_BODY_FIELDS, 'req'));
}
t('resolve still rejects junk', () => throws(() => rejectUnknownFields({refs:1}, OCP_RESOLVE_BODY_FIELDS, 'req'), 'unsupported_field'));

console.log('purpose / requested_fields / live_check');
t('purpose defaults view', () => eq(validateResolvePurpose(undefined), 'view'));
t('purpose accepts checkout', () => eq(validateResolvePurpose('checkout'), 'checkout'));
t('purpose rejects bogus', () => throws(() => validateResolvePurpose('hack'), 'unsupported_purpose'));
t('requested_fields defaults []', () => eq(JSON.stringify(validateRequestedFields(undefined)), '[]'));
t('requested_fields accepts strings', () => eq(validateRequestedFields(['a','b']).length, 2));
t('requested_fields rejects non-array', () => throws(() => validateRequestedFields('a'), 'invalid_request'));
t('requested_fields rejects non-string entry', () => throws(() => validateRequestedFields([1]), 'invalid_request'));
t('live_check defaults true', () => eq(validateLiveCheck(undefined), true));
t('live_check accepts false', () => eq(validateLiveCheck(false), false));
t('live_check rejects string', () => throws(() => validateLiveCheck('yes'), 'invalid_request'));

console.log('routes');
t('GET-only paths', () => eq(JSON.stringify(ROUTE_METHODS['/ocp/manifest']), '["GET"]'));
t('POST-only resolve', () => eq(JSON.stringify(ROUTE_METHODS['/ocp/resolve']), '["POST"]'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
