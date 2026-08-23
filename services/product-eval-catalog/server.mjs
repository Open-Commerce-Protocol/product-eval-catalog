import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { URL, pathToFileURL } from 'node:url';

const IS_MAIN_MODULE = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

const PORT = Number.parseInt(process.env.PORT || '4120', 10);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://data.deeplumen.io').replace(/\/+$/, '');
const CATALOG_ID = 'cat_product_eval_100k_v01';
const PROVIDER_ID = 'deeplumen_product_eval';
const SERVICE_VERSION = 'product-eval-catalog-api.v0.4.0';
const DATASET_PROFILE = 'source_products_synthetic_variants';
const EXPECTED_DB_USER = process.env.EXPECTED_DB_USER || 'eval_reader';
const DB_SSL_MODE = process.env.DB_SSL_MODE || 'require';
if (!['require', 'disable'].includes(DB_SSL_MODE)) {
  throw new Error('DB_SSL_MODE must be require or disable');
}
const MAX_BODY_BYTES = 1024 * 1024;
const SORT_VALUES = new Set(['relevance', 'price_asc', 'price_desc']);
const CURSOR_SIGNING_KEY = process.env.CURSOR_SIGNING_KEY_FILE
  ? fs.readFileSync(process.env.CURSOR_SIGNING_KEY_FILE, 'utf8').trim()
  : process.env.CURSOR_SIGNING_KEY;
if (IS_MAIN_MODULE && (!CURSOR_SIGNING_KEY || Buffer.byteLength(CURSOR_SIGNING_KEY, 'utf8') < 32)) {
  throw new Error('CURSOR_SIGNING_KEY_FILE or CURSOR_SIGNING_KEY must contain at least 32 bytes');
}
const RELEASE_DETAIL_FIELDS = [
  'schemaVersion',
  'catalogVersion',
  'indexVersion',
  'apiVersion',
  'datasetProfile',
  'releaseRootSha256',
];
const RELEASE_COUNT_FIELDS = [
  'productCount',
  'variantCount',
  'offerCount',
  'searchDocumentCount',
  'multiVariantProductCount',
];
const OCP_QUERY_INPUT_FIELDS = Object.freeze([
  { name: 'query', type: 'string', operators: ['contains', 'prefix', 'eq'], description: 'Optional keyword text. Maximum length: 500 characters.' },
  { name: 'sort_by', type: 'string', operators: ['eq'], description: 'Optional stable sort. Allowed values: relevance, price_asc, price_desc. Default: relevance.' },
  { name: 'cursor', type: 'string', operators: ['eq'], description: 'Opaque cursor from page.next_cursor. Maximum length: 512 bytes. It is bound to the active release and the exact query, filters, page size, and sort.' },
  { name: 'filters.category', type: 'string', operators: ['eq'], description: 'Exact categoryCode or category name.' },
  { name: 'filters.brand', type: 'string', operators: ['contains'], description: 'Case-insensitive brand code or brand name match.' },
  { name: 'filters.currency', type: 'string', operators: ['eq'], description: 'Allowed value for this release: CNY.' },
  { name: 'filters.availability_status', type: 'string', operators: ['eq'], description: 'Exact inventoryStatus, for example in_stock.' },
  { name: 'filters.sku', type: 'string', operators: ['eq'], description: 'Exact Variant SKU.' },
  { name: 'filters.min_amount', type: 'number', operators: ['gte'], description: 'Inclusive minimum Offer price. Must be non-negative.' },
  { name: 'filters.max_amount', type: 'number', operators: ['lte'], description: 'Inclusive maximum Offer price. Must be non-negative.' },
  { name: 'filters.in_stock_only', type: 'boolean', operators: ['eq'], description: 'When true, require positive inventory, in_stock status, and isSaleable=true.' },
]);

class HttpError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let pool = null;
if (IS_MAIN_MODULE) {
  const { default: pg } = await import('pg');
  const password = process.env.DB_PASSWORD_FILE
    ? fs.readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim()
    : process.env.DB_PASSWORD;

  if (!password) throw new Error('Missing DB_PASSWORD_FILE or DB_PASSWORD');

  pool = new pg.Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.DB_PORT || '15432', 10),
    database: process.env.DB_NAME || 'ocp_catalog_eval',
    user: process.env.DB_USER || 'eval_reader',
    password,
    max: Number.parseInt(process.env.DB_POOL_MAX || '12', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 3000,
    ssl: DB_SSL_MODE === 'disable'
      ? false
      : {
          rejectUnauthorized: true,
          servername: process.env.DB_TLS_SERVERNAME || 'data.deeplumen.io',
          ...(process.env.DB_SSL_ROOT_CERT_FILE
            ? { ca: fs.readFileSync(process.env.DB_SSL_ROOT_CERT_FILE, 'utf8') }
            : {}),
        },
    application_name: 'product_eval_catalog_api',
    options: '-c statement_timeout=15000 -c default_transaction_read_only=on -c max_parallel_workers_per_gather=0',
  });
}

const STANDARD_FILTERS = new Set([
  'category',
  'brand',
  'currency',
  'availability_status',
  'provider_id',
  'sku',
  'min_amount',
  'max_amount',
  'in_stock_only',
  'has_image',
]);

const API_FILTERS = new Set([
  ...STANDARD_FILTERS,
  'categoryCode',
  'productTypeCode',
  'isSaleable',
  'inventoryStatus',
  'minPrice',
  'maxPrice',
]);
const PUBLIC_PRODUCT_FIELDS = Object.freeze([
  'productId',
  'categoryCode',
  'categoryNameZh',
  'categoryNameEn',
  'productTypeCode',
  'productTypeNameZh',
  'productTypeNameEn',
  'titleZh',
  'titleEn',
  'brandCode',
  'brandName',
  'descriptionZh',
  'descriptionEn',
  'sellingPointsZh',
  'sellingPointsEn',
  'usageTags',
  'searchAliasesZh',
  'searchAliasesEn',
  'attributes',
]);
const PUBLIC_VARIANT_FIELDS = Object.freeze([
  'variantId',
  'productId',
  'sku',
  'variantTitleZh',
  'variantTitleEn',
  'optionValues',
  'variantAttributes',
  'isActive',
]);
const PUBLIC_OFFER_FIELDS = Object.freeze([
  'offerId',
  'variantId',
  'price',
  'currency',
  'listPrice',
  'inventoryStatus',
  'inventoryQuantity',
  'isSaleable',
  'snapshotTime',
]);
const PUBLIC_VERSION_FIELDS = Object.freeze([
  'schemaVersion',
  'catalogVersion',
  'indexVersion',
  'apiVersion',
  'snapshotId',
]);
const AGENT_HIDDEN_RESPONSE_FIELDS = new Set([
  'commercialFactProvenance',
  'partialProductReadyGate',
  'sourceFile',
  'sourceLine',
  'impossibleCombination',
  'contentQuality',
  'factOrigin',
]);

function redactAgentHiddenResponseFields(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactAgentHiddenResponseFields(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !AGENT_HIDDEN_RESPONSE_FIELDS.has(key))
        .map(([key, item]) => [key, redactAgentHiddenResponseFields(item)]),
    );
  }
  return value;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(redactAgentHiddenResponseFields(payload)));
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

function projectPublicFields(source, fields, label) {
  assertObject(source, label);
  const projected = {};
  for (const field of fields) {
    const value = source[field];
    if (value === undefined || value === null) {
      throw new HttpError(503, 'public_projection_invalid', `${label}.${field} is missing from the active release`);
    }
    projected[field] = value;
  }
  return projected;
}

function projectProduct(product) {
  return projectPublicFields(product, PUBLIC_PRODUCT_FIELDS, 'product');
}

function projectVariant(variant) {
  return projectPublicFields(variant, PUBLIC_VARIANT_FIELDS, 'variant');
}

function projectOffer(offer) {
  return projectPublicFields(offer, PUBLIC_OFFER_FIELDS, 'offer');
}

function projectVersion(version) {
  return projectPublicFields(version, PUBLIC_VERSION_FIELDS, 'version');
}

function projectVariantWithOffer(variant) {
  const publicVariant = projectVariant(variant);
  publicVariant.offer = projectOffer(variant.offer);
  return publicVariant;
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_request', `${label} must be a JSON object`);
  }
}

// Reject request bodies carrying fields this service does not implement, so a
// typo ("quiery") or an injected field fails loudly instead of being ignored.
function rejectUnknownFields(body, allowed, label) {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, 'unsupported_field', `${label} contains unsupported fields`, {
      unsupported: unknown.sort(),
      allowed: [...allowed].sort(),
    });
  }
}

// Prototype-pollution keys must never survive parsing, even though Node's
// JSON.parse keeps them as plain own properties.
function assertNoPollutedKeys(value, path = 'body') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPollutedKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new HttpError(400, 'invalid_request', `${path} contains a forbidden property name`, { property: key });
    }
    assertNoPollutedKeys(value[key], `${path}.${key}`);
  }
}

function assertJsonContentType(req) {
  const header = req.headers['content-type'];
  if (header === undefined || header === '') {
    throw new HttpError(415, 'unsupported_media_type', 'content-type: application/json is required', {
      required: 'application/json',
    });
  }
  const mediaType = String(header).split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json' && !mediaType.endsWith('+json')) {
    throw new HttpError(415, 'unsupported_media_type', 'content-type must be application/json', {
      received: mediaType,
      required: 'application/json',
    });
  }
}

async function readJson(req, { requireBody = true } = {}) {
  assertJsonContentType(req);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'request_too_large', `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    if (requireBody) throw new HttpError(400, 'invalid_request', 'Request body is required and must be a JSON object');
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON', { cause: error.message });
  }
  assertObject(parsed, 'request body');
  assertNoPollutedKeys(parsed);
  return parsed;
}

function parseLimit(value) {
  if (value === undefined || value === null || value === '') return 20;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new HttpError(400, 'invalid_limit', 'limit must be an integer between 1 and 50');
  }
  return n;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function requestFingerprint({ query, filters, attributeFilters, limit, sortBy, queryPack, queryMode }) {
  const normalizedRequest = canonicalize({
    query,
    filters,
    attributeFilters,
    pageSize: limit,
    sortBy,
    queryPack,
    queryMode,
  });
  return crypto.createHash('sha256').update(JSON.stringify(normalizedRequest), 'utf8').digest('hex');
}

function cursorSignature(encodedPayload, signingKey) {
  if (!signingKey || Buffer.byteLength(signingKey, 'utf8') < 32) {
    throw new Error('Cursor signing key must contain at least 32 bytes');
  }
  return crypto.createHmac('sha256', signingKey).update(encodedPayload, 'ascii').digest('base64url');
}

function parseCursor(value, release, fingerprint, sortBy, signingKey = CURSOR_SIGNING_KEY) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 512) {
    throw new HttpError(400, 'invalid_cursor', 'cursor must be a string up to 512 bytes');
  }
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/.test(value)) {
    throw new HttpError(400, 'invalid_cursor', 'cursor must use the signed base64url contract');
  }
  const parts = value.split('.');
  if (parts.length !== 2) {
    try {
      const legacy = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      if (legacy?.v === 1 || legacy?.v === 2) {
        throw new HttpError(409, 'cursor_release_mismatch', 'cursor belongs to an unsigned prior catalog release; restart pagination from the first page');
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
    }
    throw new HttpError(400, 'invalid_cursor', 'cursor signature is missing');
  }
  const [encodedPayload, providedSignature] = parts;
  const expectedSignature = cursorSignature(encodedPayload, signingKey);
  const providedBuffer = Buffer.from(providedSignature, 'ascii');
  const expectedBuffer = Buffer.from(expectedSignature, 'ascii');
  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    throw new HttpError(400, 'invalid_cursor', 'cursor signature is invalid');
  }
  let parsed;
  try {
    const decoded = Buffer.from(encodedPayload, 'base64url');
    if (decoded.toString('base64url') !== encodedPayload) throw new Error('non-canonical base64url');
    parsed = JSON.parse(decoded.toString('utf8'));
  } catch (error) {
    throw new HttpError(400, 'invalid_cursor', 'cursor payload is malformed', { cause: error.message });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_cursor', 'cursor payload must be a JSON object');
  }
  if (parsed.v !== 3) {
    throw new HttpError(409, 'cursor_release_mismatch', 'cursor belongs to a prior or unsupported catalog release; restart pagination from the first page', {
      activeSnapshotId: release.snapshotId,
    });
  }
  const allowed = new Set(['v', 'snapshotId', 'requestFingerprint', 'sortBy', 'lastId', 'lastScore', 'lastPrice']);
  const unknown = Object.keys(parsed).filter((key) => !allowed.has(key));
  if (unknown.length > 0 || !SORT_VALUES.has(parsed.sortBy)) {
    throw new HttpError(400, 'invalid_cursor', 'cursor payload has an unsupported contract');
  }
  if (parsed.snapshotId !== release.snapshotId) {
    throw new HttpError(409, 'cursor_release_mismatch', 'cursor release identity does not match the active catalog release; restart pagination from the first page', {
      cursorSnapshotId: parsed.snapshotId,
      activeSnapshotId: release.snapshotId,
    });
  }
  if (parsed.requestFingerprint !== fingerprint || parsed.sortBy !== sortBy) {
    throw new HttpError(400, 'cursor_request_mismatch', 'cursor query, filters, page size, or sort do not match the current request');
  }
  if (typeof parsed.lastId !== 'string' || !parsed.lastId) {
    throw new HttpError(400, 'invalid_cursor', 'cursor lastId must be a non-empty string');
  }
  if (parsed.sortBy === 'relevance') {
    if (!Number.isInteger(parsed.lastScore) || parsed.lastPrice !== undefined) {
      throw new HttpError(400, 'invalid_cursor', 'relevance cursor sort state is invalid');
    }
  } else if (typeof parsed.lastPrice !== 'string' || !/^\d+(?:\.\d+)?$/.test(parsed.lastPrice) || parsed.lastScore !== undefined) {
    throw new HttpError(400, 'invalid_cursor', 'price cursor sort state is invalid');
  }
  return parsed;
}

function encodeCursor(row, sortBy, release, fingerprint, signingKey = CURSOR_SIGNING_KEY) {
  const payload = sortBy === 'relevance'
    ? {
        v: 3,
        snapshotId: release.snapshotId,
        requestFingerprint: fingerprint,
        sortBy,
        lastId: row.search_document_id,
        lastScore: Number(row.relevance_score),
      }
    : {
        v: 3,
        snapshotId: release.snapshotId,
        requestFingerprint: fingerprint,
        sortBy,
        lastId: row.search_document_id,
        lastPrice: String(row.sort_price),
      };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const cursor = `${encodedPayload}.${cursorSignature(encodedPayload, signingKey)}`;
  if (cursor.length > 512) throw new Error('Generated cursor exceeds the OCP 512-byte limit');
  return cursor;
}

function validateSortBy(value) {
  if (value === undefined || value === null || value === '') return 'relevance';
  if (typeof value !== 'string' || !SORT_VALUES.has(value)) {
    throw new HttpError(400, 'invalid_sort', 'sortBy must be relevance, price_asc, or price_desc');
  }
  return value;
}

function parseQuery(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_query', 'query must be a string');
  if (value.length > 500) throw new HttpError(400, 'invalid_query', 'query must be at most 500 characters');
  return value.trim();
}

function validateFilters(filters, allowed) {
  if (filters === undefined || filters === null) return {};
  assertObject(filters, 'filters');
  const unknown = Object.keys(filters).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, 'unsupported_filter', 'Unsupported filter field', {
      unsupported: unknown,
      allowed: [...allowed].sort(),
    });
  }
  return filters;
}

function validateAttributeFilters(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'invalid_attribute_filters', 'attributeFilters must be an array');
  if (value.length > 12) throw new HttpError(400, 'invalid_attribute_filters', 'attributeFilters supports at most 12 filters');

  return value.map((filter, index) => {
    assertObject(filter, `attributeFilters[${index}]`);
    const allowed = new Set(['scope', 'attributeCode', 'valueCode', 'valueText', 'minNumericValue', 'maxNumericValue']);
    const unknown = Object.keys(filter).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new HttpError(400, 'invalid_attribute_filter', `attributeFilters[${index}] has unsupported fields`, {
        unsupported: unknown,
      });
    }

    const scope = filter.scope;
    if (!['any', 'product', 'variant', 'option'].includes(scope)) {
      throw new HttpError(400, 'invalid_attribute_filter', `attributeFilters[${index}].scope is required and must be any, product, variant, or option`);
    }
    for (const key of ['attributeCode', 'valueCode', 'valueText']) {
      if (filter[key] !== undefined && (typeof filter[key] !== 'string' || !filter[key].trim())) {
        throw new HttpError(400, 'invalid_attribute_filter', `attributeFilters[${index}].${key} must be a non-empty string`);
      }
    }
    for (const key of ['minNumericValue', 'maxNumericValue']) {
      if (filter[key] !== undefined && (typeof filter[key] !== 'number' || !Number.isFinite(filter[key]))) {
        throw new HttpError(400, 'invalid_attribute_filter', `attributeFilters[${index}].${key} must be a finite number`);
      }
    }
    if (
      filter.minNumericValue !== undefined
      && filter.maxNumericValue !== undefined
      && filter.minNumericValue > filter.maxNumericValue
    ) {
      throw new HttpError(400, 'invalid_attribute_filter', `attributeFilters[${index}] minimum cannot exceed maximum`);
    }
    if (!filter.attributeCode) {
      throw new HttpError(400, 'invalid_attribute_filter', `attributeFilters[${index}].attributeCode is required`);
    }
    if (
      !filter.valueCode &&
      !filter.valueText &&
      filter.minNumericValue === undefined &&
      filter.maxNumericValue === undefined
    ) {
      throw new HttpError(400, 'invalid_attribute_filter', `attributeFilters[${index}] must contain at least one condition`);
    }
    return {
      scope,
      attributeCode: filter.attributeCode.trim(),
      valueCode: filter.valueCode?.trim(),
      valueText: filter.valueText?.trim(),
      minNumericValue: filter.minNumericValue,
      maxNumericValue: filter.maxNumericValue,
    };
  });
}

function addParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'invalid_filter', `${name} must be a non-empty string`);
  }
  return value.trim();
}

function requireNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'invalid_filter', `${name} must be a non-negative number`);
  return n;
}

function addCommonFilters(where, params, filters) {
  const category = filters.category ?? filters.categoryCode;
  if (category !== undefined) {
    const ph = addParam(params, requireString(category, 'category'));
    where.push(`(sd."categoryCode" = ${ph} or sd."categoryNameZh" = ${ph} or sd."categoryNameEn" = ${ph})`);
  }

  if (filters.productTypeCode !== undefined) {
    where.push(`p."productTypeCode" = ${addParam(params, requireString(filters.productTypeCode, 'productTypeCode'))}`);
  }

  if (filters.brand !== undefined) {
    const ph = addParam(params, `%${requireString(filters.brand, 'brand')}%`);
    where.push(`(p."brandCode" ilike ${ph} or p."brandName" ilike ${ph})`);
  }

  if (filters.currency !== undefined) {
    where.push(`o.currency = ${addParam(params, requireString(filters.currency, 'currency').toUpperCase())}`);
  }

  const availability = filters.availability_status ?? filters.inventoryStatus;
  if (availability !== undefined) {
    where.push(`o."inventoryStatus" = ${addParam(params, requireString(availability, 'availability_status'))}`);
  }

  if (filters.provider_id !== undefined) {
    where.push(`${addParam(params, requireString(filters.provider_id, 'provider_id'))} = ${addParam(params, PROVIDER_ID)}`);
  }

  if (filters.sku !== undefined) {
    where.push(`v.sku = ${addParam(params, requireString(filters.sku, 'sku'))}`);
  }

  if (filters.min_amount !== undefined || filters.minPrice !== undefined) {
    where.push(`o.price >= ${addParam(params, requireNumber(filters.min_amount ?? filters.minPrice, 'min_amount'))}`);
  }
  if (filters.max_amount !== undefined || filters.maxPrice !== undefined) {
    where.push(`o.price <= ${addParam(params, requireNumber(filters.max_amount ?? filters.maxPrice, 'max_amount'))}`);
  }

  if (filters.in_stock_only !== undefined) {
    if (typeof filters.in_stock_only !== 'boolean') throw new HttpError(400, 'invalid_filter', 'in_stock_only must be boolean');
    if (filters.in_stock_only) where.push(`(o."inventoryStatus" = 'in_stock' and o."isSaleable" = true and o."inventoryQuantity" > 0)`);
  }

  if (filters.isSaleable !== undefined) {
    if (typeof filters.isSaleable !== 'boolean') throw new HttpError(400, 'invalid_filter', 'isSaleable must be boolean');
    where.push(`o."isSaleable" = ${addParam(params, filters.isSaleable)}`);
  }

  if (filters.has_image !== undefined) {
    throw new HttpError(400, 'unsupported_filter', 'has_image is unsupported because the evaluation dataset does not expose image_url');
  }
}

function attributeSource(scope) {
  if (scope === 'product') return `coalesce(p.attributes, '[]'::jsonb)`;
  if (scope === 'variant') return `coalesce(v."variantAttributes", '[]'::jsonb)`;
  if (scope === 'option') return `coalesce(v."optionValues", '[]'::jsonb)`;
  return `(coalesce(p.attributes, '[]'::jsonb) || coalesce(v."optionValues", '[]'::jsonb) || coalesce(v."variantAttributes", '[]'::jsonb))`;
}

function addAttributeFilters(where, params, attributeFilters) {
  for (const filter of attributeFilters) {
    const clauses = [];
    if (filter.attributeCode) clauses.push(`attr->>'attributeCode' = ${addParam(params, filter.attributeCode)}`);
    if (filter.valueCode) clauses.push(`attr->>'valueCode' = ${addParam(params, filter.valueCode)}`);
    if (filter.valueText) {
      const ph = addParam(params, `%${filter.valueText}%`);
      clauses.push(`((attr->>'valueZh') ilike ${ph} or (attr->>'valueEn') ilike ${ph} or (attr->>'attributeNameZh') ilike ${ph} or (attr->>'attributeNameEn') ilike ${ph})`);
    }
    if (filter.minNumericValue !== undefined || filter.maxNumericValue !== undefined) {
      clauses.push(`attr ? 'numericValue'`);
      clauses.push(`nullif(attr->>'numericValue','') is not null`);
    }
    if (filter.minNumericValue !== undefined) {
      clauses.push(`(attr->>'numericValue')::numeric >= ${addParam(params, filter.minNumericValue)}`);
    }
    if (filter.maxNumericValue !== undefined) {
      clauses.push(`(attr->>'numericValue')::numeric <= ${addParam(params, filter.maxNumericValue)}`);
    }
    where.push(`exists (select 1 from jsonb_array_elements(${attributeSource(filter.scope)}) as attr where ${clauses.join(' and ')})`);
  }
}

const OCP_QUERY_PACKS = Object.freeze(['ocp.query.keyword.v1', 'ocp.query.filter.v1', 'ocp.query.product-eval.v1']);

// /ocp/query is a protocol endpoint: the caller must negotiate a pack
// explicitly rather than silently inheriting a server-side default.
function validateQueryPack(pack, { required = false } = {}) {
  const allowed = new Set(OCP_QUERY_PACKS);
  if (pack === undefined || pack === null || pack === '') {
    if (required) {
      throw new HttpError(400, 'missing_query_pack', 'query_pack is required', { allowed: [...allowed] });
    }
    return 'ocp.query.product-eval.v1';
  }
  if (typeof pack !== 'string') throw new HttpError(400, 'unsupported_query_pack', 'query_pack must be a string', { allowed: [...allowed] });
  if (!allowed.has(pack)) throw new HttpError(400, 'unsupported_query_pack', 'Unsupported query_pack', { allowed: [...allowed] });
  return pack;
}

function validateQueryMode(mode) {
  const allowed = new Set(['keyword', 'filter', 'semantic', 'hybrid']);
  if (typeof mode !== 'string' || !allowed.has(mode)) throw new HttpError(400, 'unsupported_query_mode', 'Unsupported query_mode', { allowed: [...allowed] });
  if (mode === 'semantic') {
    throw new HttpError(400, 'unsupported_query_mode', 'semantic mode is not enabled; use keyword/filter/hybrid');
  }
  return mode;
}

function validatePackModeCompatibility(queryPack, queryMode) {
  const allowedModesByPack = {
    'ocp.query.keyword.v1': new Set(['keyword']),
    'ocp.query.filter.v1': new Set(['filter']),
    'ocp.query.product-eval.v1': new Set(['keyword', 'filter', 'hybrid']),
  };
  const allowed = allowedModesByPack[queryPack];
  if (!allowed?.has(queryMode)) {
    throw new HttpError(400, 'unsupported_query_mode', `query_mode=${queryMode} is not supported by query_pack=${queryPack}`, {
      query_pack: queryPack,
      query_mode: queryMode,
      allowed_query_modes: allowed ? [...allowed] : [],
    });
  }
}

function inferQueryMode(input, filters, attributeFilters, { required = false } = {}) {
  const mode = input.query_mode ?? input.queryMode;
  if (mode !== undefined && mode !== null && mode !== '') return validateQueryMode(mode);
  if (required) {
    throw new HttpError(400, 'missing_query_mode', 'query_mode is required', { allowed: ['keyword', 'filter', 'hybrid'] });
  }
  const hasQuery = !!parseQuery(input.query ?? input.q);
  const hasFilters = Object.keys(filters).length > 0 || attributeFilters.length > 0;
  if (hasQuery && hasFilters) return 'hybrid';
  if (hasQuery) return 'keyword';
  return 'filter';
}

function buildSearchSql({ query, filters, attributeFilters, cursor, limit, sortBy }) {
  const params = [];
  const where = [];
  let relevanceSql = '0::integer';
  if (query) {
    const ph = addParam(params, query);
    const contains = `'%' || ${ph} || '%'`;
    where.push(`(sd.search_text ilike ${contains} or p."titleZh" ilike ${contains} or p."titleEn" ilike ${contains} or p."brandName" ilike ${contains} or p.attributes::text ilike ${contains} or v."optionValues"::text ilike ${contains} or v."variantAttributes"::text ilike ${contains})`);
    relevanceSql = `case
      when lower(v.sku) = lower(${ph}) then 120
      when lower(p."titleZh") = lower(${ph}) or lower(p."titleEn") = lower(${ph}) then 110
      when p."titleZh" ilike ${ph} || '%' or p."titleEn" ilike ${ph} || '%' then 90
      when p."titleZh" ilike ${contains} or p."titleEn" ilike ${contains} then 70
      when p."brandName" ilike ${contains} then 50
      else 20
    end`;
  }
  addCommonFilters(where, params, filters);
  addAttributeFilters(where, params, attributeFilters);
  if (cursor) {
    if (cursor.sortBy !== sortBy) {
      throw new HttpError(400, 'cursor_sort_mismatch', 'cursor sortBy does not match the requested sortBy');
    }
    const idPh = addParam(params, cursor.lastId);
    if (sortBy === 'relevance') {
      const scorePh = addParam(params, cursor.lastScore);
      where.push(`((${relevanceSql}) < ${scorePh} or ((${relevanceSql}) = ${scorePh} and sd.search_document_id > ${idPh}))`);
    } else {
      const pricePh = addParam(params, cursor.lastPrice);
      const operator = sortBy === 'price_asc' ? '>' : '<';
      where.push(`(o.price ${operator} ${pricePh} or (o.price = ${pricePh} and sd.search_document_id > ${idPh}))`);
    }
  }
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const limitPh = addParam(params, limit + 1);
  const orderSql = sortBy === 'price_asc'
    ? 'o.price asc, sd.search_document_id asc'
    : sortBy === 'price_desc'
      ? 'o.price desc, sd.search_document_id asc'
      : `(${relevanceSql}) desc, sd.search_document_id asc`;
  const sql = `
    select
      sd.search_document_id,
      (${relevanceSql})::integer as relevance_score,
      o.price as sort_price,
      jsonb_build_object(
        'productId', p."productId", 'categoryCode', p."categoryCode", 'categoryNameZh', p."categoryNameZh",
        'categoryNameEn', p."categoryNameEn", 'productTypeCode', p."productTypeCode",
        'productTypeNameZh', p."productTypeNameZh", 'productTypeNameEn', p."productTypeNameEn",
        'titleZh', p."titleZh", 'titleEn', p."titleEn", 'brandCode', p."brandCode", 'brandName', p."brandName",
        'descriptionZh', p."descriptionZh", 'descriptionEn', p."descriptionEn",
        'sellingPointsZh', p."sellingPointsZh", 'sellingPointsEn', p."sellingPointsEn",
        'usageTags', p."usageTags", 'searchAliasesZh', p."searchAliasesZh", 'searchAliasesEn', p."searchAliasesEn",
        'attributes', p.attributes
      ) as product,
      jsonb_build_object(
        'variantId', v."variantId", 'productId', v."productId", 'sku', v.sku,
        'variantTitleZh', v."variantTitleZh", 'variantTitleEn', v."variantTitleEn",
        'optionValues', v."optionValues", 'variantAttributes', v."variantAttributes",
        'isActive', v."isActive"
      ) as variant,
      jsonb_build_object(
        'offerId', o."offerId", 'variantId', o."variantId", 'price', o.price, 'currency', o.currency,
        'listPrice', o."listPrice", 'inventoryStatus', o."inventoryStatus",
        'inventoryQuantity', o."inventoryQuantity", 'isSaleable', o."isSaleable", 'snapshotTime', o."snapshotTime"
      ) as offer,
      jsonb_build_object(
        'schemaVersion', p."schemaVersion", 'catalogVersion', p."catalogVersion",
        'indexVersion', p."indexVersion", 'apiVersion', p."apiVersion", 'snapshotId', p.snapshot_id
      ) as version
    from eval.search_documents sd
    join eval.products p on p."productId" = sd."productId"
    join eval.product_variants v on v."variantId" = sd."variantId"
    join eval.offers o on o."offerId" = sd."offerId"
    ${whereSql}
    order by ${orderSql}
    limit ${limitPh}`;
  return { sql, params };
}

function scopedAttributes(row) {
  const candidates = [
    ...((Array.isArray(row.product?.attributes) ? row.product.attributes : []).map((attribute) => ({ scope: 'product', attribute }))),
    ...((Array.isArray(row.variant?.optionValues) ? row.variant.optionValues : []).map((attribute) => ({ scope: 'option', attribute }))),
    ...((Array.isArray(row.variant?.variantAttributes) ? row.variant.variantAttributes : []).map((attribute) => ({ scope: 'variant', attribute }))),
  ];
  for (const candidate of candidates) {
    const attribute = candidate.attribute;
    if (
      !attribute
      || typeof attribute !== 'object'
      || Array.isArray(attribute)
      || typeof attribute.attributeCode !== 'string'
      || !attribute.attributeCode
    ) {
      throw new HttpError(503, 'structured_attribute_invalid', `Returned ${candidate.scope} attribute is missing a valid attributeCode`);
    }
  }
  return candidates;
}

function attributeText(attribute) {
  return [
    attribute.attributeCode,
    attribute.attributeNameZh,
    attribute.attributeNameEn,
    attribute.valueCode,
    attribute.valueZh,
    attribute.valueEn,
  ].filter((value) => typeof value === 'string' && value).join(' ').toLowerCase();
}

function attributeMatchesFilter(candidate, filter) {
  const { scope, attribute } = candidate;
  if (filter.scope !== 'any' && filter.scope !== scope) return false;
  if (filter.attributeCode && attribute.attributeCode !== filter.attributeCode) return false;
  if (filter.valueCode && attribute.valueCode !== filter.valueCode) return false;
  if (filter.valueText && !attributeText(attribute).includes(filter.valueText.toLowerCase())) return false;
  if (filter.minNumericValue !== undefined || filter.maxNumericValue !== undefined) {
    const numericValue = Number(attribute.numericValue);
    if (attribute.numericValue === undefined || attribute.numericValue === null || attribute.numericValue === '' || !Number.isFinite(numericValue)) return false;
    if (filter.minNumericValue !== undefined && numericValue < filter.minNumericValue) return false;
    if (filter.maxNumericValue !== undefined && numericValue > filter.maxNumericValue) return false;
  }
  return true;
}

function matchedAttribute(candidate, matchedBy) {
  const attribute = candidate.attribute;
  return {
    scope: candidate.scope,
    attributeCode: attribute.attributeCode,
    ...(attribute.attributeNameZh !== undefined ? { attributeNameZh: attribute.attributeNameZh } : {}),
    ...(attribute.attributeNameEn !== undefined ? { attributeNameEn: attribute.attributeNameEn } : {}),
    ...(attribute.valueCode !== undefined ? { valueCode: attribute.valueCode } : {}),
    ...(attribute.valueZh !== undefined ? { valueZh: attribute.valueZh } : {}),
    ...(attribute.valueEn !== undefined ? { valueEn: attribute.valueEn } : {}),
    ...(attribute.numericValue !== undefined ? { numericValue: attribute.numericValue } : {}),
    matchedBy,
  };
}

function summarizeHit(row, query, filters, attributeFilters) {
  const matched = [];
  if (query) matched.push({ field: 'query', value: query });
  for (const [key, value] of Object.entries(filters)) matched.push({ field: `filters.${key}`, value });

  const normalizedQuery = query.toLowerCase();
  const matchedAttributes = scopedAttributes(row).flatMap((candidate) => {
    const matchedBy = [];
    if (normalizedQuery && attributeText(candidate.attribute).includes(normalizedQuery)) matchedBy.push('query');
    attributeFilters.forEach((filter, index) => {
      if (attributeMatchesFilter(candidate, filter)) matchedBy.push(`attributeFilters[${index}]`);
    });
    return matchedBy.length > 0 ? [matchedAttribute(candidate, matchedBy)] : [];
  });
  return { matched, matchedAttributes };
}

function toEntry(row, query, filters, attributeFilters, release) {
  const product = projectProduct(row.product);
  return {
    kind: 'CatalogEntry',
    catalog_id: CATALOG_ID,
    entry_id: product.productId,
    provider_id: PROVIDER_ID,
    object_id: product.productId,
    object_type: 'ocp.commerce.product',
    commercial_object_id: product.productId,
    title: product.titleZh || product.titleEn,
    summary: product.descriptionZh || product.descriptionEn,
    attributes: {
      product,
      variant: projectVariant(row.variant),
      offer: projectOffer(row.offer),
      version: projectVersion(release),
      hit: summarizeHit(row, query, filters, attributeFilters),
    },
  };
}

// Accepted top-level request fields per surface. OCP is the strict protocol
// shape; the API/MCP surface additionally allows camelCase and attributeFilters.
// The OCP envelope fields (ocp_version/kind) and the spec-standard request
// fields the official ocp-cli sends are accepted so conformant clients are not
// rejected; unknown/typo fields still fail loudly.
const OCP_QUERY_BODY_FIELDS = new Set([
  'query_pack', 'query_mode', 'query', 'filters', 'limit', 'sort_by', 'cursor',
  'ocp_version', 'kind', 'explain', 'offset',
]);
const API_SEARCH_BODY_FIELDS = new Set([
  'query', 'q', 'filters', 'attributeFilters', 'limit', 'sortBy', 'cursor', 'query_mode', 'queryMode',
]);

async function searchProducts(input, mode) {
  assertObject(input, 'request');
  const isOcp = mode === 'ocp';
  rejectUnknownFields(input, isOcp ? OCP_QUERY_BODY_FIELDS : API_SEARCH_BODY_FIELDS, isOcp ? 'CatalogQueryRequest' : 'search request');
  if (isOcp && input.q !== undefined) {
    throw new HttpError(400, 'unsupported_field', 'OCP CatalogQueryRequest uses query, not q');
  }
  // Pagination is cursor-based. offset is accepted in the envelope for
  // spec-conformance but a non-zero value would silently return the wrong page.
  if (isOcp && input.offset !== undefined && input.offset !== null && input.offset !== 0) {
    throw new HttpError(400, 'unsupported_field', 'offset pagination is not supported; use page.next_cursor', {
      received: input.offset,
    });
  }
  const query = parseQuery(input.query ?? input.q);
  const filters = validateFilters(input.filters, isOcp ? STANDARD_FILTERS : API_FILTERS);
  if (isOcp && input.attributeFilters !== undefined) {
    throw new HttpError(400, 'unsupported_field', 'OCP CatalogQueryRequest does not support attributeFilters; use /api/search or /mcp');
  }
  const attributeFilters = isOcp ? [] : validateAttributeFilters(input.attributeFilters);
  const limit = parseLimit(input.limit);
  const sortBy = validateSortBy(isOcp ? input.sort_by : input.sortBy);
  const queryPack = isOcp ? validateQueryPack(input.query_pack, { required: true }) : 'product-eval.api.search.v1';
  const queryMode = inferQueryMode(input, filters, attributeFilters, { required: isOcp });
  if (isOcp) validatePackModeCompatibility(queryPack, queryMode);
  // A keyword/hybrid request with no keyword would otherwise degrade into an
  // unfiltered table scan that looks like a successful search.
  if (!query && (queryMode === 'keyword' || queryMode === 'hybrid')) {
    throw new HttpError(400, 'invalid_query', `query_mode=${queryMode} requires a non-empty query`, { query_mode: queryMode });
  }
  if (queryMode === 'filter' && Object.keys(filters).length === 0 && attributeFilters.length === 0) {
    throw new HttpError(400, 'invalid_query', 'query_mode=filter requires at least one filter', { query_mode: queryMode });
  }
  const release = await activeRelease();
  const fingerprint = requestFingerprint({ query, filters, attributeFilters, limit, sortBy, queryPack, queryMode });
  const cursor = parseCursor(input.cursor, release, fingerprint, sortBy);
  const { sql, params } = buildSearchSql({ query, filters, attributeFilters, cursor, limit, sortBy });
  const result = await pool.query(sql, params);
  result.rows.forEach((row) => assertRowReleaseIdentity(row.version, release));
  const rows = result.rows.slice(0, limit);
  const hasMore = result.rows.length > limit;
  const nextCursor = hasMore ? encodeCursor(rows.at(-1), sortBy, release, fingerprint) : undefined;
  const items = rows.map((row) => ({
    entry: toEntry(row, query, filters, attributeFilters, releaseIdentity(release)),
    score: query ? 1 : 0.8,
    explain: [
      query ? `Matched keyword query: ${query}` : 'Matched structured filters',
      `snapshot_id=${release.snapshotId}`,
      `catalogVersion=${release.catalogVersion}`,
      `indexVersion=${release.indexVersion}`,
    ],
  }));
  return { query, filters, attributeFilters, limit, cursor, queryPack, queryMode, sortBy, items, hasMore, nextCursor, release };
}

async function fetchProductRow(productId) {
  const sql = `
    select
      sd.search_document_id,
      jsonb_build_object(
        'productId', p."productId", 'categoryCode', p."categoryCode", 'categoryNameZh', p."categoryNameZh",
        'categoryNameEn', p."categoryNameEn", 'productTypeCode', p."productTypeCode",
        'productTypeNameZh', p."productTypeNameZh", 'productTypeNameEn', p."productTypeNameEn",
        'titleZh', p."titleZh", 'titleEn', p."titleEn", 'brandCode', p."brandCode", 'brandName', p."brandName",
        'descriptionZh', p."descriptionZh", 'descriptionEn', p."descriptionEn",
        'sellingPointsZh', p."sellingPointsZh", 'sellingPointsEn', p."sellingPointsEn",
        'usageTags', p."usageTags", 'searchAliasesZh', p."searchAliasesZh", 'searchAliasesEn', p."searchAliasesEn",
        'attributes', p.attributes
      ) as product,
      jsonb_build_object(
        'variantId', v."variantId", 'productId', v."productId", 'sku', v.sku,
        'variantTitleZh', v."variantTitleZh", 'variantTitleEn', v."variantTitleEn",
        'optionValues', v."optionValues", 'variantAttributes', v."variantAttributes",
        'isActive', v."isActive"
      ) as variant,
      jsonb_build_object(
        'offerId', o."offerId", 'variantId', o."variantId", 'price', o.price, 'currency', o.currency,
        'listPrice', o."listPrice", 'inventoryStatus', o."inventoryStatus",
        'inventoryQuantity', o."inventoryQuantity", 'isSaleable', o."isSaleable", 'snapshotTime', o."snapshotTime"
      ) as offer,
      jsonb_build_object(
        'schemaVersion', p."schemaVersion", 'catalogVersion', p."catalogVersion",
        'indexVersion', p."indexVersion", 'apiVersion', p."apiVersion", 'snapshotId', p.snapshot_id
      ) as version
    from eval.search_documents sd
    join eval.products p on p."productId" = sd."productId"
    join eval.product_variants v on v."variantId" = sd."variantId"
    join eval.offers o on o."offerId" = sd."offerId"
    where p."productId" = $1
    order by sd.search_document_id asc
    limit 1`;
  const result = await pool.query(sql, [productId]);
  if (result.rowCount === 0) throw new HttpError(404, 'entry_not_found', `No catalog entry found for ${productId}`);
  return result.rows[0];
}

async function readOnlyCheck() {
  const result = await pool.query(`select current_user, current_setting('transaction_read_only') as transaction_read_only`);
  const row = result.rows[0];
  const passed = row?.current_user === EXPECTED_DB_USER && row?.transaction_read_only === 'on';
  return {
    passed,
    currentUser: row?.current_user,
    transactionReadOnly: row?.transaction_read_only,
  };
}

const OCP_RESOLVE_PACKS = Object.freeze(['ocp.resolve.product.v1', 'ocp.resolve.product-eval.v1']);
const OCP_RESOLVE_MODES = Object.freeze(['exact', 'live']);
const OCP_RESOLVE_PURPOSES = Object.freeze(['view', 'checkout', 'contact', 'workflow']);
// entry_id plus the standard OCP ResolveRequest envelope/spec fields the
// official ocp-cli sends. Anything outside this set is a client bug.
const OCP_RESOLVE_BODY_FIELDS = new Set([
  'entry_id', 'entryId', 'object_id', 'query_pack', 'query_mode', 'response_mode',
  'ocp_version', 'kind', 'purpose', 'live_check', 'requested_fields',
]);
const API_RESOLVE_BODY_FIELDS = new Set(['entry_id', 'entryId', 'productId', 'response_mode']);

function validateResolvePurpose(purpose) {
  const allowed = new Set(OCP_RESOLVE_PURPOSES);
  if (purpose === undefined || purpose === null || purpose === '') return 'view';
  if (typeof purpose !== 'string' || !allowed.has(purpose)) {
    throw new HttpError(400, 'unsupported_purpose', 'Unsupported resolve purpose', { allowed: [...allowed] });
  }
  return purpose;
}

function validateRequestedFields(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'invalid_request', 'requested_fields must be an array of strings');
  for (const field of value) {
    if (typeof field !== 'string' || !field.trim()) {
      throw new HttpError(400, 'invalid_request', 'requested_fields entries must be non-empty strings');
    }
  }
  return value;
}

function validateLiveCheck(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'boolean') throw new HttpError(400, 'invalid_request', 'live_check must be a boolean');
  return value;
}

// Resolve accepts a pack/mode ("款式") so callers can negotiate it like /ocp/query,
// but the pack only selects verification depth -- it never changes the projection.
function validateResolvePack(pack) {
  const allowed = new Set(OCP_RESOLVE_PACKS);
  if (pack === undefined || pack === null || pack === '') return 'ocp.resolve.product.v1';
  if (typeof pack !== 'string' || !allowed.has(pack)) {
    throw new HttpError(400, 'unsupported_resolve_pack', 'Unsupported query_pack for resolve', { allowed: [...allowed] });
  }
  return pack;
}

function validateResolveMode(mode) {
  const allowed = new Set(OCP_RESOLVE_MODES);
  if (mode === undefined || mode === null || mode === '') return 'exact';
  if (typeof mode !== 'string' || !allowed.has(mode)) {
    throw new HttpError(400, 'unsupported_resolve_mode', 'Unsupported query_mode for resolve', { allowed: [...allowed] });
  }
  return mode;
}

function validateResponseMode(mode) {
  const allowed = new Set(['full', 'status']);
  if (mode === undefined || mode === null || mode === '') return 'full';
  if (typeof mode !== 'string' || !allowed.has(mode)) {
    throw new HttpError(400, 'unsupported_response_mode', 'response_mode must be full or status', { allowed: [...allowed] });
  }
  return mode;
}

function requireEntryId(value, name = 'entry_id') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'invalid_entry_id', `${name} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > 128) {
    throw new HttpError(400, 'invalid_entry_id', `${name} must be at most 128 characters`);
  }
  return trimmed;
}

async function resolveProduct(entryId, options = {}) {
  const resolvePack = options.resolvePack ?? 'ocp.resolve.product.v1';
  const resolveMode = options.resolveMode ?? 'exact';
  const release = await activeRelease();
  const row = await fetchProductRow(requireEntryId(entryId, options.idFieldName ?? 'entry_id'));
  assertRowReleaseIdentity(row.version, release);
  const dbReadOnly = await readOnlyCheck();
  if (!dbReadOnly.passed) {
    throw new HttpError(503, 'database_read_only_check_failed', 'The catalog database session did not pass the required read-only identity check', {
      expectedUser: EXPECTED_DB_USER,
      currentUser: dbReadOnly.currentUser,
      transactionReadOnly: dbReadOnly.transactionReadOnly,
    });
  }
  const resolvedAt = new Date().toISOString();
  const objectUpdatedAt = row.offer.snapshotTime ? new Date(row.offer.snapshotTime).toISOString() : resolvedAt;
  const product = projectProduct(row.product);
  return {
    ocp_version: '1.0',
    kind: 'ResolvableReference',
    id: `res_${crypto.randomUUID()}`,
    catalog_id: CATALOG_ID,
    ...releaseIdentity(release),
    query_pack: resolvePack,
    query_mode: resolveMode,
    purpose: options.purpose ?? 'view',
    entry_id: product.productId,
    commercial_object_id: product.productId,
    object_id: product.productId,
    object_type: 'ocp.commerce.product',
    provider_id: PROVIDER_ID,
    title: product.titleZh || product.titleEn,
    visible_attributes: {
      product,
      variant: projectVariant(row.variant),
      offer: projectOffer(row.offer),
      version: projectVersion(releaseIdentity(release)),
    },
    action_bindings: [],
    freshness: {
      object_updated_at: objectUpdatedAt,
      resolved_at: resolvedAt,
    },
    live_checks: [
      {
        check_id: 'database_transaction_read_only',
        status: dbReadOnly.passed ? 'passed' : 'failed',
        checked_at: resolvedAt,
        summary: dbReadOnly.passed ? `The active database session is read-only ${EXPECTED_DB_USER}.` : 'The active database session did not pass read-only verification.',
        details: { currentUser: dbReadOnly.currentUser, transactionReadOnly: dbReadOnly.transactionReadOnly },
      },
      {
        check_id: 'eval_snapshot_ready',
        status: 'passed',
        checked_at: resolvedAt,
        summary: `Resolved from snapshot ${release.snapshotId}.`,
        details: { snapshotId: release.snapshotId, catalogVersion: release.catalogVersion },
      },
    ],
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
}

// Compact success/failure projection of a full resolve, for callers that only
// need to know whether the reference is still resolvable.
function toResolveStatus(resolved) {
  return {
    ocp_version: '1.0',
    kind: 'ResolveResult',
    id: resolved.id,
    catalog_id: resolved.catalog_id,
    snapshotId: resolved.snapshotId,
    catalogVersion: resolved.catalogVersion,
    query_pack: resolved.query_pack,
    query_mode: resolved.query_mode,
    purpose: resolved.purpose,
    response_mode: 'status',
    entry_id: resolved.entry_id,
    object_type: resolved.object_type,
    status: 'success',
    resolved: true,
    checks_passed: resolved.live_checks.every((check) => check.status === 'passed'),
    live_checks: resolved.live_checks.map((check) => ({ check_id: check.check_id, status: check.status })),
    resolved_at: resolved.freshness.resolved_at,
    expires_at: resolved.expires_at,
  };
}

// Failure counterpart of toResolveStatus: same envelope, status="failed".
function toResolveFailure(error, context) {
  return {
    ocp_version: '1.0',
    kind: 'ResolveResult',
    catalog_id: CATALOG_ID,
    query_pack: context.resolvePack,
    query_mode: context.resolveMode,
    response_mode: 'status',
    ...(context.entryId !== undefined ? { entry_id: context.entryId } : {}),
    status: 'failed',
    resolved: false,
    checks_passed: false,
    error: { code: error.code, message: error.message, details: error.details },
  };
}

async function ocpResolve(body) {
  assertObject(body, 'ResolveRequest');
  rejectUnknownFields(body, OCP_RESOLVE_BODY_FIELDS, 'ResolveRequest');
  const resolvePack = validateResolvePack(body.query_pack);
  const resolveMode = validateResolveMode(body.query_mode);
  const responseMode = validateResponseMode(body.response_mode);
  const purpose = validateResolvePurpose(body.purpose);
  validateRequestedFields(body.requested_fields);
  validateLiveCheck(body.live_check);
  const rawEntryId = body.entry_id ?? body.entryId ?? body.object_id;
  const entryId = requireEntryId(rawEntryId);
  try {
    const resolved = await resolveProduct(entryId, { resolvePack, resolveMode, purpose });
    return { status: 200, payload: responseMode === 'status' ? toResolveStatus(resolved) : resolved };
  } catch (error) {
    // In status mode a miss is still a well-formed answer: report it in the
    // ResolveResult envelope instead of a bare error object.
    if (responseMode === 'status' && error instanceof HttpError) {
      return { status: error.status, payload: toResolveFailure(error, { resolvePack, resolveMode, entryId }) };
    }
    throw error;
  }
}

async function apiResolveProduct(entryId) {
  const resolved = await resolveProduct(entryId);
  return {
    product: resolved.visible_attributes.product,
    variant: resolved.visible_attributes.variant,
    offer: resolved.visible_attributes.offer,
    version: resolved.visible_attributes.version,
  };
}

async function listProductVariants(productId) {
  const release = await activeRelease();
  const result = await pool.query(`
    select jsonb_build_object(
      'variantId', v."variantId", 'productId', v."productId", 'sku', v.sku,
      'variantTitleZh', v."variantTitleZh", 'variantTitleEn', v."variantTitleEn",
      'optionValues', v."optionValues", 'variantAttributes', v."variantAttributes",
      'isActive', v."isActive",
      'schemaVersion', v."schemaVersion", 'catalogVersion', v."catalogVersion", 'snapshotId', v.snapshot_id,
      'offer', jsonb_build_object(
        'offerId', o."offerId", 'variantId', o."variantId", 'price', o.price, 'currency', o.currency,
        'listPrice', o."listPrice",
        'inventoryStatus', o."inventoryStatus", 'inventoryQuantity', o."inventoryQuantity",
        'isSaleable', o."isSaleable", 'snapshotTime', o."snapshotTime"
      )
    ) as variant
    from eval.product_variants v
    join eval.offers o on o."variantId" = v."variantId"
    where v."productId" = $1
    order by v."variantId" asc
    limit 50`, [requireEntryId(productId, 'productId')]);
  if (result.rowCount === 0) throw new HttpError(404, 'product_not_found', `No variants found for ${productId}`);
  for (const row of result.rows) {
    if (
      row.variant?.schemaVersion !== release.schemaVersion
      || row.variant?.catalogVersion !== release.catalogVersion
      || row.variant?.snapshotId !== release.snapshotId
    ) {
      throw new HttpError(503, 'release_identity_inconsistent', 'Variant row release identity does not match eval.dataset_readiness', {
        variantId: row.variant?.variantId,
      });
    }
  }
  return { productId, version: projectVersion(releaseIdentity(release)), variants: result.rows.map((row) => projectVariantWithOffer(row.variant)) };
}

async function readiness() {
  const result = await pool.query('select snapshot_id, eval_v0_1_ready, blocking_gap_count, readiness_status, readiness_details, checked_at from eval.dataset_readiness');
  if (result.rowCount !== 1) {
    throw new HttpError(503, 'dataset_readiness_invalid', 'eval.dataset_readiness must expose exactly one authoritative row', {
      rowCount: result.rowCount,
    });
  }
  return result.rows[0];
}

function requireReadinessString(details, key) {
  const value = details[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(503, 'dataset_readiness_invalid', `readiness_details.${key} is missing or invalid`);
  }
  return value;
}

function requireReadinessCount(details, key) {
  const value = details[key];
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HttpError(503, 'dataset_readiness_invalid', `readiness_details.${key} is missing or invalid`);
  }
  return value;
}

function parseActiveRelease(ready) {
  if (ready.eval_v0_1_ready !== true || ready.blocking_gap_count !== 0 || ready.readiness_status !== 'eval_v0_1_ready') {
    throw new HttpError(503, 'dataset_not_ready', 'The active evaluation release is not ready', {
      evalV01Ready: ready.eval_v0_1_ready,
      blockingGapCount: ready.blocking_gap_count,
      readinessStatus: ready.readiness_status,
    });
  }
  if (!ready.readiness_details || typeof ready.readiness_details !== 'object' || Array.isArray(ready.readiness_details)) {
    throw new HttpError(503, 'dataset_readiness_invalid', 'readiness_details must be a JSON object');
  }
  const snapshotId = typeof ready.snapshot_id === 'string' ? ready.snapshot_id.trim() : '';
  if (!snapshotId) throw new HttpError(503, 'dataset_readiness_invalid', 'snapshot_id is missing or invalid');

  const details = ready.readiness_details;
  const releaseDetails = Object.fromEntries(RELEASE_DETAIL_FIELDS.map((key) => [key, requireReadinessString(details, key)]));
  if (releaseDetails.datasetProfile !== DATASET_PROFILE) {
    throw new HttpError(503, 'dataset_readiness_invalid', 'readiness_details.datasetProfile does not match the supported dataset profile', {
      expected: DATASET_PROFILE,
      actual: releaseDetails.datasetProfile,
    });
  }
  if (!/^[a-f0-9]{64}$/.test(releaseDetails.releaseRootSha256)) {
    throw new HttpError(503, 'dataset_readiness_invalid', 'readiness_details.releaseRootSha256 must be a lowercase SHA-256 digest');
  }
  const counts = Object.fromEntries(RELEASE_COUNT_FIELDS.map((key) => [key, requireReadinessCount(details, key)]));
  if (counts.variantCount !== counts.offerCount || counts.variantCount !== counts.searchDocumentCount) {
    throw new HttpError(503, 'dataset_readiness_invalid', 'Variant, Offer, and search document counts must be identical', counts);
  }
  if (counts.variantCount < counts.productCount || counts.multiVariantProductCount > counts.productCount) {
    throw new HttpError(503, 'dataset_readiness_invalid', 'readiness counts violate Product/Variant cardinality invariants', counts);
  }
  if (details.stableEvalPublicationSwitched !== true) {
    throw new HttpError(503, 'dataset_not_published', 'The v15 release is built but the stable eval publication has not been activated');
  }
  const checkedAt = new Date(ready.checked_at);
  if (Number.isNaN(checkedAt.getTime())) {
    throw new HttpError(503, 'dataset_readiness_invalid', 'checked_at is missing or invalid');
  }
  return {
    snapshotId,
    ...releaseDetails,
    ...counts,
    checkedAt: checkedAt.toISOString(),
  };
}

async function activeRelease() {
  return parseActiveRelease(await readiness());
}

function releaseIdentity(release) {
  return {
    schemaVersion: release.schemaVersion,
    catalogVersion: release.catalogVersion,
    indexVersion: release.indexVersion,
    apiVersion: release.apiVersion,
    snapshotId: release.snapshotId,
  };
}

function assertRowReleaseIdentity(version, release) {
  const expected = releaseIdentity(release);
  for (const key of ['schemaVersion', 'catalogVersion', 'indexVersion', 'apiVersion', 'snapshotId']) {
    if (version?.[key] !== expected[key]) {
      throw new HttpError(503, 'release_identity_inconsistent', `Database row ${key} does not match eval.dataset_readiness`, {
        expected: expected[key],
        actual: version?.[key],
      });
    }
  }
}

function manifestObjectContracts() {
  return [
    {
      object_type: 'Product',
      name: 'Product',
      description: 'Baseline catalog product object exposed to evaluated agents.',
      required_fields: [
        'product#/productId', 'product#/categoryCode', 'product#/categoryNameZh', 'product#/categoryNameEn',
        'product#/productTypeCode', 'product#/productTypeNameZh', 'product#/productTypeNameEn',
        'product#/titleZh', 'product#/titleEn', 'product#/brandCode', 'product#/brandName',
        'product#/descriptionZh', 'product#/descriptionEn', 'product#/sellingPointsZh',
        'product#/sellingPointsEn', 'product#/usageTags', 'product#/searchAliasesZh',
        'product#/searchAliasesEn', 'product#/attributes',
      ],
      additional_fields_policy: 'reject',
      identity_policy: {
        accepted_identity_keys: ['external_source_key'],
        dedupe_scope: 'source',
        provider_sku_trust: 'not_accepted',
        requires_authority_verification: false,
      },
    },
    {
      object_type: 'ProductVariant',
      name: 'ProductVariant',
      description: 'Concrete purchasable product variant with structured option values.',
      required_fields: [
        'variant#/variantId', 'variant#/productId', 'variant#/sku',
        'variant#/variantTitleZh', 'variant#/variantTitleEn', 'variant#/optionValues',
        'variant#/variantAttributes', 'variant#/isActive',
      ],
      additional_fields_policy: 'reject',
      identity_policy: {
        accepted_identity_keys: ['provider_sku', 'external_source_key'],
        dedupe_scope: 'catalog',
        provider_sku_trust: 'accepted_as_claim',
        requires_authority_verification: false,
      },
    },
    {
      object_type: 'Offer',
      name: 'Offer',
      description: 'Variant-level price, inventory, and saleability snapshot.',
      required_fields: [
        'offer#/offerId', 'offer#/variantId', 'offer#/price', 'offer#/currency',
        'offer#/listPrice', 'offer#/inventoryStatus', 'offer#/inventoryQuantity',
        'offer#/isSaleable', 'offer#/snapshotTime',
      ],
      additional_fields_policy: 'reject',
      identity_policy: {
        accepted_identity_keys: ['external_source_key'],
        dedupe_scope: 'catalog',
        provider_sku_trust: 'not_accepted',
        requires_authority_verification: false,
      },
    },
  ];
}

function buildManifest(release) {
  const productCount = release.productCount;
  const variantCount = release.variantCount;
  const offerCount = release.offerCount;
  return {
    ocp_version: '1.0',
    kind: 'CatalogManifest',
    id: 'manifest_product_eval_100k_v01',
    catalog_id: CATALOG_ID,
    catalog_name: 'Deeplumen Product Discovery Eval Catalog 100k',
    description: 'Read-only OCP catalog over the product discovery 100k evaluation dataset. Dynamic product/variant attribute filters are exposed through /api/search and /mcp.',
    registry_visibility: 'public',
    endpoints: {
      health: { url: `${PUBLIC_BASE_URL}/ocp/health`, method: 'GET' },
      query: { url: `${PUBLIC_BASE_URL}/ocp/query`, method: 'POST' },
      resolve: { url: `${PUBLIC_BASE_URL}/ocp/resolve`, method: 'POST' },
    },
    resolve_capability: {
      capability_id: 'product_eval_resolve_v1',
      name: 'Product entry resolve with success/failure status mode',
      description: 'Resolve one product entry_id. query_pack/query_mode select verification depth; response_mode=status returns only success/failure plus live-check results.',
      query_packs: [
        { pack_id: 'ocp.resolve.product.v1', query_modes: [...OCP_RESOLVE_MODES], description: 'Resolve a product entry by exact entry_id.' },
        { pack_id: 'ocp.resolve.product-eval.v1', query_modes: [...OCP_RESOLVE_MODES], description: 'Product eval alias of the product resolve pack.' },
      ],
      response_modes: [
        { mode: 'full', description: 'Default. Returns the full ResolvableReference including visible_attributes.' },
        { mode: 'status', description: 'Returns a compact ResolveResult with status success/failed, resolved, and checks_passed only.' },
      ],
      required_input_fields: ['entry_id'],
      accepted_input_fields: [...OCP_RESOLVE_BODY_FIELDS].sort(),
      purposes: [...OCP_RESOLVE_PURPOSES],
      strict_request_validation: true,
    },
    query_capabilities: [{
      capability_id: 'product_eval_search_v1',
      name: 'Product keyword and structured commerce filter search',
      description: 'Search product entries and filter by category, brand, price, currency, SKU, and saleability.',
      query_packs: [
        { pack_id: 'ocp.query.product-eval.v1', query_modes: ['keyword', 'filter', 'hybrid'], description: 'Product eval catalog keyword/filter/hybrid query.' },
        { pack_id: 'ocp.query.keyword.v1', query_modes: ['keyword'], description: 'Keyword-only query.' },
        { pack_id: 'ocp.query.filter.v1', query_modes: ['filter'], description: 'Filter-only query.' },
      ],
      searchable_field_refs: [
        'product#/titleZh',
        'product#/titleEn',
        'product#/descriptionZh',
        'product#/descriptionEn',
        'product#/brandName',
        'search_document#/search_text',
        'variant#/sku',
      ],
      filterable_field_refs: [
        'query#/filters/category',
        'query#/filters/brand',
        'query#/filters/currency',
        'query#/filters/availability_status',
        'query#/filters/sku',
        'query#/filters/min_amount',
        'query#/filters/max_amount',
        'query#/filters/in_stock_only',
      ],
      sortable_field_refs: ['query#/sort_by'],
      input_fields: OCP_QUERY_INPUT_FIELDS,
      supports_explain: true,
      supports_resolve: true,
      metadata: {
        release_identity: releaseIdentity(release),
        input_constraints: {
          query_max_length: 500,
          cursor_max_bytes: 512,
          page_size: { default: 20, minimum: 1, maximum: 50 },
          sort_by: ['relevance', 'price_asc', 'price_desc'],
          currency: ['CNY'],
          strict_request_validation: true,
          required_request_fields: ['query_pack', 'query_mode'],
          required_content_type: 'application/json',
          rejects_unknown_request_fields: true,
          allowed_request_fields: [...OCP_QUERY_BODY_FIELDS].sort(),
        },
        structured_attribute_filters: {
          api_url: `${PUBLIC_BASE_URL}/api/search`,
          mcp_url: `${PUBLIC_BASE_URL}/mcp`,
          fields: ['scope', 'attributeCode', 'valueCode', 'valueText', 'minNumericValue', 'maxNumericValue'],
          scopes: ['product', 'variant', 'option', 'any'],
          examples: [
            { scope: 'option', attributeCode: 'color', valueCode: 'black' },
            { scope: 'option', attributeCode: 'size', valueText: '42' },
            { scope: 'option', attributeCode: 'capacity', minNumericValue: 10000 },
            { scope: 'option', attributeCode: 'configuration', valueCode: 'fast_charge' },
          ],
        },
      },
    }],
    data_profile: {
      catalog_entry_count: productCount,
      object_counts: [
        { object_type: 'ocp.commerce.product', count: productCount },
        { object_type: 'ocp.commerce.product_variant', count: variantCount },
        { object_type: 'ocp.commerce.offer', count: offerCount },
      ],
      counted_at: release.checkedAt,
    },
    object_contracts: manifestObjectContracts(),
  };
}

async function manifest() {
  return buildManifest(await activeRelease());
}

function buildHealth(release) {
  return {
    ocp_version: '1.0',
    kind: 'CatalogHealth',
    catalog_id: CATALOG_ID,
    status: 'healthy',
    ready: true,
    checked_at: release.checkedAt,
    manifest_version: SERVICE_VERSION,
    details: {
      ...releaseIdentity(release),
      blockingGapCount: 0,
      serviceVersion: SERVICE_VERSION,
    },
    dependencies: [{ name: 'postgresql_eval_publication', status: 'healthy' }],
  };
}

async function ocpQuery(body) {
  const result = await searchProducts(body, 'ocp');
  return {
    ocp_version: '1.0',
    kind: 'CatalogQueryResult',
    id: `qry_${crypto.randomUUID()}`,
    catalog_id: CATALOG_ID,
    ...releaseIdentity(result.release),
    query_pack: result.queryPack,
    query_mode: result.queryMode,
    sort_by: result.sortBy,
    query: result.query,
    result_count: result.items.length,
    page: { limit: result.limit, offset: 0, has_more: result.hasMore, ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}) },
    entries: result.items,
    policy_summary: {
      selected_capability_id: 'product_eval_search_v1',
      selected_query_pack: result.queryPack,
      query_mode: result.queryMode,
      sort_by: result.sortBy,
      supports_explain: true,
      accepted_filters: Object.keys(result.filters),
      rejected_filters: [],
      warnings: [],
    },
    explain: [`serviceVersion=${SERVICE_VERSION}`, `queryMode=${result.queryMode}`, `sortBy=${result.sortBy}`],
  };
}

async function apiSearch(body) {
  const result = await searchProducts(body, 'api');
  return {
    version: projectVersion(releaseIdentity(result.release)),
    page: { limit: result.limit, hasMore: result.hasMore, nextCursor: result.nextCursor },
    items: result.items.map((item) => item.entry.attributes),
  };
}

function mcpTools() {
  return [
    {
      name: 'searchProducts',
      description: 'Search by keyword, standard commerce filters, and structured product/variant attribute filters.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', maxLength: 500 },
          filters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              categoryCode: { type: 'string', minLength: 1 },
              productTypeCode: { type: 'string', minLength: 1 },
              brand: { type: 'string', minLength: 1 },
              currency: { type: 'string', enum: ['CNY'] },
              sku: { type: 'string', minLength: 1 },
              inventoryStatus: { type: 'string', enum: ['in_stock', 'low_stock', 'out_of_stock'] },
              isSaleable: { type: 'boolean' },
              minPrice: { type: 'number', minimum: 0 },
              maxPrice: { type: 'number', minimum: 0 },
            },
          },
          attributeFilters: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['scope', 'attributeCode'],
              properties: {
                scope: { type: 'string', enum: ['product', 'variant', 'option', 'any'] },
                attributeCode: { type: 'string', enum: ['color', 'size', 'capacity', 'configuration'] },
                valueCode: { type: 'string', minLength: 1 },
                valueText: { type: 'string', minLength: 1 },
                minNumericValue: { type: 'number' },
                maxNumericValue: { type: 'number' },
              },
              anyOf: [
                { required: ['valueCode'] },
                { required: ['valueText'] },
                { required: ['minNumericValue'] },
                { required: ['maxNumericValue'] },
              ],
            },
          },
          sortBy: { type: 'string', enum: ['relevance', 'price_asc', 'price_desc'] },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          cursor: { type: 'string', maxLength: 512 },
        },
        anyOf: [{ required: ['query'] }, { required: ['filters'] }, { required: ['attributeFilters'] }],
      },
    },
    {
      name: 'getProductDetail',
      description: 'Resolve one product entry returned by searchProducts or /ocp/query.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { productId: { type: 'string', minLength: 1 }, entryId: { type: 'string', minLength: 1 } },
        anyOf: [{ required: ['productId'] }, { required: ['entryId'] }],
      },
    },
    {
      name: 'listProductVariants',
      description: 'List variants and offers for a productId.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { productId: { type: 'string', minLength: 1 } },
        required: ['productId'],
      },
    },
  ];
}

async function mcp(body) {
  assertObject(body, 'JSON-RPC request');
  const id = body.id ?? null;
  try {
    if (body.method === 'initialize') {
      const release = await activeRelease();
      return {
        jsonrpc: '2.0',
        id,
        result: {
          ...releaseIdentity(release),
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'deeplumen-product-eval-catalog', version: SERVICE_VERSION },
        },
      };
    }
    if (body.method === 'tools/list') {
      const release = await activeRelease();
      return { jsonrpc: '2.0', id, result: { ...releaseIdentity(release), tools: mcpTools() } };
    }
    if (body.method === 'tools/call') {
      assertObject(body.params, 'params');
      if (typeof body.params.name !== 'string' || !body.params.name) throw new HttpError(400, 'invalid_mcp_request', 'params.name must be a non-empty string');
      if (body.params.arguments === undefined) throw new HttpError(400, 'invalid_mcp_request', 'params.arguments is required');
      assertObject(body.params.arguments, 'params.arguments');
      const params = body.params;
      const args = params.arguments;
      let result;
      if (params.name === 'searchProducts') result = await apiSearch(args);
      else if (params.name === 'getProductDetail') result = await apiResolveProduct(args.productId || args.entryId);
      else if (params.name === 'listProductVariants') result = await listProductVariants(args.productId);
      else throw new HttpError(400, 'unknown_tool', `Unknown MCP tool ${params.name}`);
      const visibleResult = redactAgentHiddenResponseFields(result);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(visibleResult, null, 2) }],
          structuredContent: visibleResult,
          isError: false,
        },
      };
    }
    if (body.method === 'notifications/initialized') {
      const release = await activeRelease();
      return { jsonrpc: '2.0', id, result: releaseIdentity(release) };
    }
    throw new HttpError(400, 'unknown_method', `Unknown MCP method ${body.method}`);
  } catch (error) {
    if (error instanceof HttpError) {
      return { jsonrpc: '2.0', id, error: { code: error.status, message: error.message, data: { code: error.code, ...error.details } } };
    }
    throw error;
  }
}

function usageMarkdown() {
  return `# Deeplumen Product Eval Catalog

Base URL: ${PUBLIC_BASE_URL}

## Install OCP CLI

\`\`\`bash
npm install -g @ocp-catalog/ocp-cli
ocp catalog inspect ${PUBLIC_BASE_URL}/ocp/manifest
\`\`\`

## Agent search and pagination

For evaluation tasks, agents must use the MCP \`searchProducts\` tool for keyword,
structured filter, attribute filter, sorting, and cursor pagination. Continue by
passing \`structuredContent.page.nextCursor\` back as the tool's \`cursor\` argument.

Use OCP CLI for manifest inspection, query validation, and resolving a selected
entry. The raw OCP endpoint also returns \`page.next_cursor\`, but
\`@ocp-catalog/ocp-cli@0.1.3\` does not preserve that response field. Do not use
that CLI version for multi-page evaluation search.

## Single-page OCP query

\`\`\`bash
ocp catalog query \\
  --manifest ${PUBLIC_BASE_URL}/ocp/manifest \\
  --query-url ${PUBLIC_BASE_URL}/ocp/query \\
  --query-pack ocp.query.product-eval.v1 \\
  --query-mode hybrid \\
  --query "running shoes" \\
  --filters '{"category":"shoes_apparel","currency":"CNY","in_stock_only":true,"min_amount":100,"max_amount":500}'
\`\`\`

The raw query response returns \`page.next_cursor\` when \`page.has_more=true\`.
Supported stable sorts are \`relevance\`, \`price_asc\`, and \`price_desc\`; equal
scores or prices are ordered by immutable search document ID.

## Resolve one result

Use \`entries[0].entry.entry_id\` from query:

\`\`\`bash
ocp catalog resolve --resolve-url ${PUBLIC_BASE_URL}/ocp/resolve --entry-id <productId>
\`\`\`

Resolve accepts an optional pack/mode, and \`response_mode\` selects how much of
the reference is returned. \`full\` (default) returns the whole
\`ResolvableReference\`; \`status\` returns only whether the entry resolved.

\`\`\`bash
curl -sS ${PUBLIC_BASE_URL}/ocp/resolve \\
  -H 'content-type: application/json' \\
  -d '{
    "entry_id": "<productId>",
    "query_pack": "ocp.resolve.product.v1",
    "query_mode": "exact",
    "response_mode": "status"
  }'
\`\`\`

Status mode answers with \`kind: "ResolveResult"\` and
\`status: "success" | "failed"\`, plus \`resolved\` and \`checks_passed\`. A missing
entry returns HTTP 404 in the same envelope with \`status: "failed"\` rather than
a bare error, so success and failure are distinguishable without parsing the
product payload.

Resolve packs: \`ocp.resolve.product.v1\`, \`ocp.resolve.product-eval.v1\`.
Resolve modes: \`exact\`, \`live\`.

## Request validation

The service rejects malformed requests instead of silently coercing them:

- \`content-type: application/json\` is required on every POST; anything else is \`415 unsupported_media_type\`.
- Unknown top-level request fields are rejected with \`400 unsupported_field\` and the allowed list, so a typo never degrades into an ignored filter.
- \`/ocp/query\` requires explicit \`query_pack\` and \`query_mode\`; omitting either is \`400 missing_query_pack\` / \`400 missing_query_mode\`.
- \`query_mode=keyword|hybrid\` requires a non-empty \`query\`; \`query_mode=filter\` requires at least one filter.
- \`__proto__\`, \`constructor\`, and \`prototype\` property names are refused anywhere in the body.
- A wrong HTTP method on a known path returns \`405 method_not_allowed\` with an \`Allow\` header, not \`404\`.

## Structured attribute search API

OCP CLI currently accepts only fixed standard filter keys. For dynamic attributes such as color, size, capacity, and configuration, use API/MCP:

\`\`\`bash
curl -sS ${PUBLIC_BASE_URL}/api/search \\
  -H 'content-type: application/json' \\
  -d '{
    "query": "boot",
    "filters": {"categoryCode":"shoes_apparel", "isSaleable": true, "minPrice": 100},
    "attributeFilters": [
      {"scope":"option", "attributeCode":"color", "valueCode":"black"},
      {"scope":"option", "attributeCode":"size", "valueText":"41"}
    ],
    "sortBy": "price_asc",
    "limit": 5
  }'
\`\`\`

All attribute filters are evaluated against the same Variant row. A filter
combination returns zero when no single Variant contains all requested option
values; values from different Variants are never combined.

## MCP endpoint

Endpoint: \`${PUBLIC_BASE_URL}/mcp\`

Tools:

- \`searchProducts\`
- \`getProductDetail\`
- \`listProductVariants\`

Use \`searchProducts\` for all evaluation searches. Its response includes the
actual matched structured attributes and the active release identity.
`;
}

// Declared method(s) per known path, so a wrong-method request answers 405
// with an Allow header instead of a misleading 404.
const ROUTE_METHODS = Object.freeze({
  '/': ['GET'],
  '/docs': ['GET'],
  '/usage.md': ['GET'],
  '/ocp/health': ['GET'],
  '/ocp/manifest': ['GET'],
  '/ocp/query': ['POST'],
  '/ocp/resolve': ['POST'],
  '/api/search': ['POST'],
  '/api/resolve': ['POST'],
  '/api/variants': ['POST'],
  '/mcp': ['POST'],
});

async function route(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization,mcp-protocol-version',
      'access-control-max-age': '600',
    });
    res.end();
    return;
  }

  const cors = { 'access-control-allow-origin': '*' };
  const allowedMethods = ROUTE_METHODS[url.pathname];
  if (!allowedMethods) {
    throw new HttpError(404, 'not_found', `No route for ${req.method} ${url.pathname}`);
  }
  if (!allowedMethods.includes(req.method)) {
    throw new HttpError(405, 'method_not_allowed', `${req.method} is not allowed for ${url.pathname}`, { allowed: allowedMethods });
  }

  if (url.pathname === '/' || url.pathname === '/docs') {
    return sendJson(res, 200, {
      service: 'Deeplumen Product Eval Catalog',
      version: SERVICE_VERSION,
      ocpManifest: `${PUBLIC_BASE_URL}/ocp/manifest`,
      ocpQuery: `${PUBLIC_BASE_URL}/ocp/query`,
      ocpResolve: `${PUBLIC_BASE_URL}/ocp/resolve`,
      apiSearch: `${PUBLIC_BASE_URL}/api/search`,
      mcp: `${PUBLIC_BASE_URL}/mcp`,
      usage: `${PUBLIC_BASE_URL}/usage.md`,
    }, cors);
  }
  if (url.pathname === '/usage.md') return sendText(res, 200, usageMarkdown(), 'text/markdown; charset=utf-8');
  if (url.pathname === '/ocp/health') {
    return sendJson(res, 200, buildHealth(await activeRelease()), cors);
  }
  if (url.pathname === '/ocp/manifest') return sendJson(res, 200, await manifest(), cors);
  if (url.pathname === '/ocp/query') return sendJson(res, 200, await ocpQuery(await readJson(req)), cors);
  if (url.pathname === '/ocp/resolve') {
    const { status, payload } = await ocpResolve(await readJson(req));
    return sendJson(res, status, payload, cors);
  }
  if (url.pathname === '/api/search') return sendJson(res, 200, await apiSearch(await readJson(req)), cors);
  if (url.pathname === '/api/resolve') {
    const body = await readJson(req);
    rejectUnknownFields(body, API_RESOLVE_BODY_FIELDS, 'resolve request');
    const responseMode = validateResponseMode(body.response_mode);
    const entryId = requireEntryId(body.productId ?? body.entryId ?? body.entry_id, 'productId');
    if (responseMode === 'status') {
      const { status, payload } = await ocpResolve({ entry_id: entryId, response_mode: 'status' });
      return sendJson(res, status, payload, cors);
    }
    return sendJson(res, 200, await apiResolveProduct(entryId), cors);
  }
  if (url.pathname === '/api/variants') {
    const body = await readJson(req);
    rejectUnknownFields(body, new Set(['productId', 'entryId', 'entry_id']), 'variants request');
    return sendJson(res, 200, await listProductVariants(body.productId ?? body.entryId ?? body.entry_id), cors);
  }
  if (url.pathname === '/mcp') return sendJson(res, 200, await mcp(await readJson(req)), cors);
  throw new HttpError(404, 'not_found', `No route for ${req.method} ${url.pathname}`);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    const status = error instanceof HttpError ? error.status : 500;
    const payload = error instanceof HttpError
      ? { error: { code: error.code, message: error.message, details: error.details } }
      : { error: { code: 'internal_error', message: 'Internal server error' } };
    if (!(error instanceof HttpError)) {
      console.error('Unhandled request error', error);
    }
    const headers = { 'access-control-allow-origin': '*' };
    if (status === 405 && Array.isArray(error.details?.allowed)) {
      headers.allow = error.details.allowed.join(', ');
    }
    sendJson(res, status, payload, headers);
  });
});

if (IS_MAIN_MODULE) {
  process.on('SIGTERM', () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  });

  server.listen(PORT, HOST, () => {
    console.log(`product-eval-catalog listening on http://${HOST}:${PORT}`);
  });
}

export {
  HttpError,
  OCP_QUERY_INPUT_FIELDS,
  OCP_QUERY_BODY_FIELDS,
  OCP_RESOLVE_BODY_FIELDS,
  OCP_RESOLVE_PURPOSES,
  ROUTE_METHODS,
  attributeMatchesFilter,
  assertNoPollutedKeys,
  buildHealth,
  buildManifest,
  buildSearchSql,
  encodeCursor,
  matchedAttribute,
  parseActiveRelease,
  parseCursor,
  rejectUnknownFields,
  requestFingerprint,
  requireEntryId,
  releaseIdentity,
  redactAgentHiddenResponseFields,
  summarizeHit,
  toResolveStatus,
  usageMarkdown,
  validateAttributeFilters,
  validateQueryPack,
  validateLiveCheck,
  validateRequestedFields,
  validateResolvePack,
  validateResolveMode,
  validateResolvePurpose,
  validateResponseMode,
};
