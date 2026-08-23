import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

import pg from 'pg';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SNAPSHOT_ID = 'v20260822_variant_enriched_01';

async function availablePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForHealth(baseUrl, childOutput) {
  const deadline = Date.now() + 10000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/ocp/health`);
      const body = await response.json();
      if (response.ok) return body;
      lastError = new Error(`health returned ${response.status}: ${JSON.stringify(body)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy: ${lastError?.message}\n${childOutput()}`);
}

async function jsonRequest(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, `${pathname}: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitForDatabase(pool) {
  const deadline = Date.now() + 10000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await pool.query('select 1');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`database did not become ready: ${lastError?.message}`);
}

async function seedDatabase(pool) {
  await pool.query(`
    drop schema if exists eval cascade;
    create schema eval;

    create table eval.dataset_readiness (
      snapshot_id text not null,
      source_snapshot_ready boolean not null,
      eval_v0_1_ready boolean not null,
      readiness_status text not null,
      blocking_gap_count integer not null,
      readiness_details jsonb not null,
      checked_at timestamptz not null
    );
    create table eval.snapshot_manifest (
      snapshot_id text not null,
      "catalogVersion" text not null,
      "schemaVersion" text not null,
      "indexVersion" text not null,
      "apiVersion" text not null,
      source_artifact text not null,
      source_artifact_sha256 text not null,
      llm_artifact text not null,
      llm_artifact_sha256 text not null,
      source_snapshot_ready boolean not null,
      eval_v0_1_ready boolean not null,
      readiness_status text not null,
      blocking_gap_count integer not null,
      published_at timestamptz not null
    );
    create table eval.products (
      "productId" text primary key,
      "categoryCode" text not null,
      "categoryNameZh" text not null,
      "categoryNameEn" text not null,
      "productTypeCode" text not null,
      "productTypeNameZh" text not null,
      "productTypeNameEn" text not null,
      "titleZh" text not null,
      "titleEn" text not null,
      "brandCode" text not null,
      "brandName" text not null,
      "descriptionZh" text not null,
      "descriptionEn" text not null,
      "sellingPointsZh" jsonb not null,
      "sellingPointsEn" jsonb not null,
      "usageTags" jsonb not null,
      "searchAliasesZh" jsonb not null,
      "searchAliasesEn" jsonb not null,
      attributes jsonb not null,
      "schemaVersion" text not null,
      "catalogVersion" text not null,
      "indexVersion" text not null,
      "apiVersion" text not null,
      snapshot_id text not null
    );
    create table eval.product_variants (
      "variantId" text primary key,
      "productId" text not null,
      sku text not null,
      "variantTitleZh" text not null,
      "variantTitleEn" text not null,
      "optionValues" jsonb not null,
      "variantAttributes" jsonb not null,
      "isActive" boolean not null,
      "classificationStatus" text not null,
      "schemaVersion" text not null,
      "catalogVersion" text not null,
      snapshot_id text not null
    );
    create table eval.offers (
      "offerId" text primary key,
      "variantId" text not null,
      price numeric(12,2) not null,
      currency text not null,
      "listPrice" numeric(12,2),
      "inventoryStatus" text not null,
      "inventoryQuantity" integer not null,
      "isSaleable" boolean not null,
      "snapshotTime" timestamptz not null,
      snapshot_id text not null
    );
    create table eval.search_documents (
      search_document_id text primary key,
      "productId" text not null,
      "variantId" text not null,
      "offerId" text not null,
      "categoryCode" text not null,
      "categoryNameZh" text not null,
      "categoryNameEn" text not null,
      "productTypeCode" text not null,
      "titleZh" text not null,
      "titleEn" text not null,
      "brandCode" text not null,
      "brandName" text not null,
      sku text not null,
      price numeric(12,2) not null,
      currency text not null,
      "inventoryStatus" text not null,
      "isSaleable" boolean not null,
      search_text text not null,
      "indexVersion" text not null,
      snapshot_id text not null
    );

    insert into eval.dataset_readiness values (
      '${SNAPSHOT_ID}', true, true, 'eval_v0_1_ready', 0,
      '{"datasetProfile":"source_products_synthetic_variants","productCount":1,"variantCount":2,"offerCount":2,"searchDocumentCount":2,"multiVariantProductCount":1,"stableEvalPublicationSwitched":true}',
      '2026-08-22T15:30:41Z'
    );
    insert into eval.snapshot_manifest values (
      '${SNAPSHOT_ID}', 'catalog-v20260822-variant-enriched-01', 'product-eval-schema.v2',
      'product-eval-search-index.v2', 'product-eval-api.v1', '/source.jsonl', '${'a'.repeat(64)}',
      '/llm.jsonl', '${'b'.repeat(64)}', true, true, 'eval_v0_1_ready', 0, '2026-08-22T15:30:41Z'
    );
    insert into eval.products values (
      'prd_bag_1', 'bags', '箱包', 'Bags', 'handbag', '手提包', 'Handbag',
      '黑色通勤包', 'Black commuter bag', 'deeplumen', 'DeepLumen', '轻量通勤包',
      'Lightweight commuter bag', '["轻量"]', '["Lightweight"]', '["commute"]', '["包"]', '["bag"]',
      '[]', 'product-eval-schema.v2', 'catalog-v20260822-variant-enriched-01',
      'product-eval-search-index.v2', 'product-eval-api.v1', '${SNAPSHOT_ID}'
    );
    insert into eval.product_variants values
      ('var_bag_black', 'prd_bag_1', 'BAG-BLACK', '黑色', 'Black',
       '[{"attributeCode":"color","attributeNameZh":"颜色","attributeNameEn":"Color","valueCode":"black","valueZh":"黑色","valueEn":"Black"}]',
       '[]', true, 'classified', 'product-eval-schema.v2', 'catalog-v20260822-variant-enriched-01', '${SNAPSHOT_ID}'),
      ('var_bag_red', 'prd_bag_1', 'BAG-RED', '红色', 'Red',
       '[{"attributeCode":"color","attributeNameZh":"颜色","attributeNameEn":"Color","valueCode":"red","valueZh":"红色","valueEn":"Red"}]',
       '[]', true, 'classified', 'product-eval-schema.v2', 'catalog-v20260822-variant-enriched-01', '${SNAPSHOT_ID}');
    insert into eval.offers values
      ('off_bag_black', 'var_bag_black', 199.00, 'CNY', 229.00, 'in_stock', 8, true, '2026-08-22T15:30:41Z', '${SNAPSHOT_ID}'),
      ('off_bag_red', 'var_bag_red', 209.00, 'CNY', 239.00, 'in_stock', 6, true, '2026-08-22T15:30:41Z', '${SNAPSHOT_ID}');
    insert into eval.search_documents values
      ('doc_bag_black', 'prd_bag_1', 'var_bag_black', 'off_bag_black', 'bags', '箱包', 'Bags', 'handbag',
       '黑色通勤包', 'Black commuter bag', 'deeplumen', 'DeepLumen', 'BAG-BLACK', 199.00, 'CNY', 'in_stock', true,
       'black commuter bag 黑色 通勤 包', 'product-eval-search-index.v2', '${SNAPSHOT_ID}'),
      ('doc_bag_red', 'prd_bag_1', 'var_bag_red', 'off_bag_red', 'bags', '箱包', 'Bags', 'handbag',
       '黑色通勤包', 'Black commuter bag', 'deeplumen', 'DeepLumen', 'BAG-RED', 209.00, 'CNY', 'in_stock', true,
       'red commuter bag 红色 通勤 包', 'product-eval-search-index.v2', '${SNAPSHOT_ID}');
  `);
}

test('serves health, manifest, search, resolve, variants, and MCP from manifest-backed readiness', {
  skip: !TEST_DATABASE_URL && 'TEST_DATABASE_URL is not set',
  timeout: 30000,
}, async () => {
  const databaseUrl = new URL(TEST_DATABASE_URL);
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'product-eval-catalog-it-'));
  const passwordFile = path.join(tempDir, 'db-password');
  await writeFile(passwordFile, decodeURIComponent(databaseUrl.password), { mode: 0o600 });
  await waitForDatabase(pool);
  await seedDatabase(pool);

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_BASE_URL: baseUrl,
      DB_HOST: databaseUrl.hostname,
      DB_PORT: databaseUrl.port,
      DB_NAME: databaseUrl.pathname.slice(1),
      DB_USER: decodeURIComponent(databaseUrl.username),
      DB_PASSWORD_FILE: passwordFile,
      DB_SSL_MODE: 'disable',
      EXPECTED_DB_USER: decodeURIComponent(databaseUrl.username),
      CURSOR_SIGNING_KEY: 'integration-test-signing-key-00000000000000000000000000000000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const health = await waitForHealth(baseUrl, () => `${stdout}\n${stderr}`);
    assert.equal(health.ready, true);
    assert.equal(health.details.snapshotId, SNAPSHOT_ID);

    const manifestResponse = await fetch(`${baseUrl}/ocp/manifest`);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.query_capabilities[0].metadata.release_identity.snapshotId, SNAPSHOT_ID);
    assert.equal(manifest.data_profile.catalog_entry_count, 1);

    const apiSearch = await jsonRequest(baseUrl, '/api/search', {
      query: 'bag',
      limit: 3,
      attributeFilters: [{ scope: 'option', attributeCode: 'color', valueCode: 'black' }],
    });
    assert.equal(apiSearch.items.length, 1);
    assert.equal(apiSearch.items[0].variant.variantId, 'var_bag_black');

    const ocpQuery = await jsonRequest(baseUrl, '/ocp/query', {
      query_pack: 'ocp.query.product-eval.v1',
      query_mode: 'keyword',
      query: 'bag',
      limit: 1,
    });
    assert.equal(ocpQuery.entries.length, 1);

    const resolved = await jsonRequest(baseUrl, '/api/resolve', { productId: 'prd_bag_1' });
    assert.equal(resolved.product.productId, 'prd_bag_1');
    assert.equal(resolved.version.snapshotId, SNAPSHOT_ID);

    const variants = await jsonRequest(baseUrl, '/api/variants', { productId: 'prd_bag_1' });
    assert.equal(variants.variants.length, 2);

    const mcp = await jsonRequest(baseUrl, '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    assert.equal(mcp.result.snapshotId, SNAPSHOT_ID);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    await pool.end();
    await rm(tempDir, { recursive: true, force: true });
  }
});
