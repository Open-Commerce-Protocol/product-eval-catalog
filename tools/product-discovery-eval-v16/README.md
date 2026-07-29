# Product Eval v16 local Qwen variant-plan runner

This directory is a local-only v16 tool package. It prepares sanitized Product
inputs, asks Qwen `qwen3.7-plus` for strict JSON variant plans, and writes
resumable shard outputs. It intentionally does not publish to DB and does not
generate final Variant/Offer/SearchDocument rows.

Secrets are read only from environment:

```powershell
$env:QWEN_API_KEY = "<secret>"
# or
$env:QWEN_API_KEY_FILE = "C:\secure\qwen_api_key.txt"
```

## 1. Prepare sanitized inputs

```powershell
python .\.codex-work\product-eval-v16\prepare_input_from_normalized.py `
  --input C:\path\to\normalized-products.jsonl `
  --output .\.codex-work\product-eval-v16\prepared-products.jsonl `
  --product-id-path productId
```

The output keeps `productId` only in the local envelope. `llmInput` is sanitized
and rejects source IDs, URLs, handles, source keys, provenance, links, and raw
source payloads.

## 2. Initialize a resumable run

```powershell
python .\.codex-work\product-eval-v16\llm_variant_plan_runner.py init `
  --input .\.codex-work\product-eval-v16\prepared-products.jsonl `
  --work-dir .\.codex-work\product-eval-v16\runs\qwen-v16-r1 `
  --shard-count 64 `
  --concurrency 8
```

Initialization writes:

- `run-manifest.json`
- `run-control.json`
- `prompt_contract.md`
- `shards/shard-*/input.jsonl`
- `shards/shard-*/status.json`

## 3. Run remotely or locally

From a remote shell in the repository root:

```bash
export QWEN_API_KEY_FILE=/secure/qwen_api_key
python .codex-work/product-eval-v16/llm_variant_plan_runner.py supervisor \
  --work-dir .codex-work/product-eval-v16/runs/qwen-v16-r1 \
  --poll-seconds 5 \
  --timeout-seconds 120
```

The supervisor launches shard workers as subprocesses and re-reads
`run-control.json` every poll interval.

## 4. Monitor and adjust concurrency

```powershell
python .\.codex-work\product-eval-v16\llm_variant_plan_runner.py status `
  --work-dir .\.codex-work\product-eval-v16\runs\qwen-v16-r1

python .\.codex-work\product-eval-v16\llm_variant_plan_runner.py set-control `
  --work-dir .\.codex-work\product-eval-v16\runs\qwen-v16-r1 `
  --concurrency 30
```

## 5. Gracefully stop

```powershell
python .\.codex-work\product-eval-v16\llm_variant_plan_runner.py stop `
  --work-dir .\.codex-work\product-eval-v16\runs\qwen-v16-r1
```

Workers stop before starting the next Product. Completed Product outputs remain
on disk; a shard marked `success` is immutable and will not be re-run.

To resume after a stop:

```powershell
python .\.codex-work\product-eval-v16\llm_variant_plan_runner.py set-control `
  --work-dir .\.codex-work\product-eval-v16\runs\qwen-v16-r1 `
  --stop false `
  --concurrency 8

python .\.codex-work\product-eval-v16\llm_variant_plan_runner.py supervisor `
  --work-dir .\.codex-work\product-eval-v16\runs\qwen-v16-r1
```

## 6. Merge after every shard succeeds

```powershell
python .\.codex-work\product-eval-v16\llm_variant_plan_runner.py merge `
  --work-dir .\.codex-work\product-eval-v16\runs\qwen-v16-r1 `
  --output .\.codex-work\product-eval-v16\variant-plans.qwen-v16-r1.jsonl
```

Merge fails loudly unless every shard status is exactly `success`, every Product
appears once, and every variant plan passes the strict contract validator.

## Failure behavior

- Missing API key fails before network calls.
- Invalid JSONL, invalid prepared input, invalid model JSON, and contract
  violations fail loudly.
- Product failures are written to `shards/<shard>/failures.jsonl`.
- Failed shards remain non-success and block merge.
- No API key or response body is written to disk.
