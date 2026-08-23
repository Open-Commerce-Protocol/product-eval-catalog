import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpError, buildHealth, parseActiveRelease, readiness } from './server.mjs';

const SOURCE_SHA = 'a'.repeat(64);
const LLM_SHA = 'b'.repeat(64);
const RELEASE_ROOT_SHA = 'c'.repeat(64);

function currentReleaseRow() {
  return {
    snapshot_id: 'v20260822_variant_enriched_01',
    source_snapshot_ready: true,
    eval_v0_1_ready: true,
    blocking_gap_count: 0,
    readiness_status: 'eval_v0_1_ready',
    readiness_details: {
      datasetProfile: 'source_products_synthetic_variants',
      productCount: 100000,
      variantCount: 261434,
      offerCount: 261434,
      searchDocumentCount: 261434,
      multiVariantProductCount: 48333,
      stableEvalPublicationSwitched: true,
    },
    checked_at: '2026-08-22T15:30:41.000Z',
    manifest_snapshot_id: 'v20260822_variant_enriched_01',
    manifest_schema_version: 'product-eval-schema.v2',
    manifest_catalog_version: 'catalog-v20260822-variant-enriched-01',
    manifest_index_version: 'product-eval-search-index.v2',
    manifest_api_version: 'product-eval-api.v1',
    manifest_source_artifact_sha256: SOURCE_SHA,
    manifest_llm_artifact_sha256: LLM_SHA,
    manifest_source_snapshot_ready: true,
    manifest_eval_v0_1_ready: true,
    manifest_blocking_gap_count: 0,
    manifest_readiness_status: 'eval_v0_1_ready',
  };
}

function cloneRow() {
  return structuredClone(currentReleaseRow());
}

function legacyReleaseRow() {
  const row = cloneRow();
  Object.assign(row, {
    snapshot_id: 'v20260729_partial_v16_31k_01',
    manifest_snapshot_id: 'v20260729_partial_v16_31k_01',
    manifest_schema_version: 'product-eval-schema.v16.partial.1',
    manifest_catalog_version: 'catalog-v20260729-partial-v16-31k-01',
    manifest_index_version: 'product-eval-search-index.v16.partial.1',
    manifest_api_version: 'product-eval-catalog-api.v16.partial.1',
    checked_at: '2026-07-31T02:10:10.617Z',
  });
  Object.assign(row.readiness_details, {
    schemaVersion: row.manifest_schema_version,
    catalogVersion: row.manifest_catalog_version,
    indexVersion: row.manifest_index_version,
    apiVersion: row.manifest_api_version,
    releaseRootSha256: RELEASE_ROOT_SHA,
    productCount: 31537,
    variantCount: 94372,
    offerCount: 94372,
    searchDocumentCount: 94372,
    multiVariantProductCount: 31537,
  });
  return row;
}

function assertHttpError(error, code) {
  assert.ok(error instanceof HttpError);
  assert.equal(error.code, code);
  return true;
}

test('accepts the current release when duplicated readiness versions are absent', () => {
  const release = parseActiveRelease(currentReleaseRow());

  assert.deepEqual(
    {
      snapshotId: release.snapshotId,
      schemaVersion: release.schemaVersion,
      catalogVersion: release.catalogVersion,
      indexVersion: release.indexVersion,
      apiVersion: release.apiVersion,
    },
    {
      snapshotId: 'v20260822_variant_enriched_01',
      schemaVersion: 'product-eval-schema.v2',
      catalogVersion: 'catalog-v20260822-variant-enriched-01',
      indexVersion: 'product-eval-search-index.v2',
      apiVersion: 'product-eval-api.v1',
    },
  );
  assert.equal(release.sourceArtifactSha256, SOURCE_SHA);
  assert.equal(release.llmArtifactSha256, LLM_SHA);
  assert.equal(release.releaseRootSha256, undefined);
  assert.equal(release.productCount, 100000);
  assert.equal(buildHealth(release).ready, true);
});

test('accepts a legacy readiness row when duplicated identity matches the manifest', () => {
  const release = parseActiveRelease(legacyReleaseRow());
  assert.equal(release.snapshotId, 'v20260729_partial_v16_31k_01');
  assert.equal(release.catalogVersion, 'catalog-v20260729-partial-v16-31k-01');
  assert.equal(release.productCount, 31537);
  assert.equal(release.releaseRootSha256, RELEASE_ROOT_SHA);
});

test('rejects a duplicated readiness identity that conflicts with the manifest', () => {
  const row = cloneRow();
  row.readiness_details.catalogVersion = 'catalog-stale';

  assert.throws(
    () => parseActiveRelease(row),
    (error) => assertHttpError(error, 'release_identity_inconsistent'),
  );
});

test('rejects a missing snapshot manifest', () => {
  const row = cloneRow();
  row.manifest_snapshot_id = null;

  assert.throws(
    () => parseActiveRelease(row),
    (error) => assertHttpError(error, 'dataset_manifest_invalid'),
  );
});

test('rejects a manifest with a missing release version', () => {
  const row = cloneRow();
  row.manifest_schema_version = null;

  assert.throws(
    () => parseActiveRelease(row),
    (error) => assertHttpError(error, 'dataset_manifest_invalid'),
  );
});

test('rejects a manifest snapshot mismatch', () => {
  const row = cloneRow();
  row.manifest_snapshot_id = 'another-snapshot';

  assert.throws(
    () => parseActiveRelease(row),
    (error) => assertHttpError(error, 'release_identity_inconsistent'),
  );
});

test('rejects a manifest that is not independently ready', () => {
  const row = cloneRow();
  row.manifest_eval_v0_1_ready = false;

  assert.throws(
    () => parseActiveRelease(row),
    (error) => assertHttpError(error, 'dataset_manifest_invalid'),
  );
});

test('rejects readiness when the source snapshot is not ready', () => {
  const row = cloneRow();
  row.source_snapshot_ready = false;

  assert.throws(
    () => parseActiveRelease(row),
    (error) => assertHttpError(error, 'dataset_not_ready'),
  );
});

test('rejects malformed artifact hashes from the manifest', () => {
  const row = cloneRow();
  row.manifest_llm_artifact_sha256 = 'not-a-sha256';

  assert.throws(
    () => parseActiveRelease(row),
    (error) => assertHttpError(error, 'dataset_manifest_invalid'),
  );
});

test('rejects a malformed legacy release root when it is present', () => {
  const row = cloneRow();
  row.readiness_details.releaseRootSha256 = 'not-a-sha256';

  assert.throws(
    () => parseActiveRelease(row),
    (error) => assertHttpError(error, 'dataset_readiness_invalid'),
  );
});

test('retains readiness count invariants', () => {
  const row = cloneRow();
  row.readiness_details.offerCount -= 1;

  assert.throws(
    () => parseActiveRelease(row),
    (error) => assertHttpError(error, 'dataset_readiness_invalid'),
  );
});

test('retains publication activation gating', () => {
  const row = cloneRow();
  row.readiness_details.stableEvalPublicationSwitched = false;

  assert.throws(
    () => parseActiveRelease(row),
    (error) => assertHttpError(error, 'dataset_not_published'),
  );
});

test('readiness queries the manifest and returns its single joined row', async () => {
  let sql;
  const row = currentReleaseRow();
  const result = await readiness({
    query: async (value) => {
      sql = value;
      return { rowCount: 1, rows: [row] };
    },
  });

  assert.equal(result, row);
  assert.match(sql, /from eval\.dataset_readiness r/);
  assert.match(sql, /left join eval\.snapshot_manifest m on m\.snapshot_id = r\.snapshot_id/);
});

test('readiness rejects zero or ambiguous joined rows', async () => {
  for (const rowCount of [0, 2]) {
    await assert.rejects(
      readiness({ query: async () => ({ rowCount, rows: [] }) }),
      (error) => assertHttpError(error, 'dataset_readiness_invalid'),
    );
  }
});
