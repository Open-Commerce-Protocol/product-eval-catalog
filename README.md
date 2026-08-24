# Product Eval Catalog

Independent OCP/API/MCP query service and v16 data-generation tooling for the Deeplumen product discovery evaluation catalog.

This repository intentionally does not live inside `OCP-Catalog`; it is a standalone catalog instance used by `data.deeplumen.io`.

## Live environment

- Base URL: `https://data.deeplumen.io`
- Health: `https://data.deeplumen.io/ocp/health`
- Manifest: `https://data.deeplumen.io/ocp/manifest`
- OCP Query: `https://data.deeplumen.io/ocp/query`
- API Search: `https://data.deeplumen.io/api/search`
- MCP: `https://data.deeplumen.io/mcp`

Current published partial release:

- `snapshotId`: `v20260729_partial_v16_31k_01`
- `catalogVersion`: `catalog-v20260729-partial-v16-31k-01`
- Products: `31,537`
- Variants / Offers / Search documents: `94,372`
- Variant count per product: `2-3`
- Dataset scope: `partial_llm_variant_quality_gate`

## Server layout

- Service root: `/home/ubuntu/services/product-eval-catalog`
- v16 generation root: `/home/ubuntu/services/product-discovery-eval-v16`
- DB deploy root: `/home/ubuntu/services/product-discovery-eval-db`
- systemd unit: `product-eval-catalog.service`
- local bind: `127.0.0.1:4120`
- PostgreSQL container: `product_discovery_eval_postgres`
- database: `ocp_catalog_eval`
- public schema: `eval`
- current version schema: `eval_v20260729_partial_v16_31k_01`

## Secrets and artifacts

This repository excludes runtime secrets, DB password files, cursor signing keys, node_modules, dumps, inputs, runs, and JSONL data artifacts.

The accepted partial data artifact currently lives only on the server:

```text
/home/ubuntu/services/product-discovery-eval-v16/runs/qwen-v16-full100k-r1/quality/partial-product-ready-20260729T044801Z/accepted.product-ready.partial.jsonl
```

Accepted artifact SHA-256:

```text
61f08f734cd9aa3a28c45c8762e7d436d07483fb8dc9e642043a1f18d250a1e2
```

Pre-change DB backup before the partial publish:

```text
/home/ubuntu/services/product-discovery-eval-db/backups/ocp_catalog_eval_before_v20260729_partial_v16_31k_01.dump
```

Backup SHA-256:

```text
30adb7b14a4a2f2340e79ab1b634de108470b658620845df32a3f85f3dd242c6
```

## Quick checks

```bash
curl https://data.deeplumen.io/ocp/health
curl https://data.deeplumen.io/ocp/manifest
```

API example:

```bash
curl https://data.deeplumen.io/api/search \
  -H 'content-type: application/json' \
  --data '{
    "query": "bag",
    "limit": 3,
    "attributeFilters": [
      {"scope":"option","attributeCode":"color","valueCode":"black"}
    ]
  }'
```

OCP query example:

```bash
curl https://data.deeplumen.io/ocp/query \
  -H 'content-type: application/json' \
  --data '{
    "query_pack":"ocp.query.product-eval.v1",
    "query_mode":"filter",
    "filters": {
      "product_type":"backpacks",
      "attributes":[{"scope":"product","attributeCode":"waterproof","valueCode":"true"}]
    },
    "limit":2
  }'
```

MCP tools:

- `searchProducts`
- `getProductDetail`
- `listProductVariants`

## Operational note

This is a partial product-ready release for product acceptance, not the final 100k baseline. The full 100k LLM generation run remains paused and should be resumed only after product confirms the partial release direction.
