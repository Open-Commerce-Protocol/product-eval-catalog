#!/usr/bin/env python3
"""Stdlib-only Qwen runner for Product Eval v16 variant plans."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import traceback
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "product-eval-v16-run.v1"
INPUT_SCHEMA = "product-eval-v16-llm-input.v1"
PLAN_SCHEMA = "product-eval-variant-plan.v1"
DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
DEFAULT_MODEL = "qwen3.7-plus"
VALID_DIMENSIONS = {"color", "size", "capacity", "configuration"}
VALUE_CODE_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789_")
VALUE_CODE_PATTERN = re.compile(r"[^a-z0-9]+")


class RunnerError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise RunnerError(message)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise RunnerError(f"{label} is missing: {path}") from error
    except json.JSONDecodeError as error:
        raise RunnerError(f"{label} is not valid JSON: {path}") from error
    if not isinstance(value, dict):
        fail(f"{label} must be a JSON object: {path}")
    return value


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp_path, path)


def append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(canonical_json(value) + "\n")


def iter_jsonl(path: Path, label: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                fail(f"{label} contains a blank line at {line_number}")
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise RunnerError(f"{label} contains invalid JSON at line {line_number}") from error
            if not isinstance(value, dict):
                fail(f"{label} line {line_number} must be a JSON object")
            rows.append(value)
    return rows


def require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{label} must be a non-empty string")
    return value.strip()


def require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        fail(f"{label} must be a list")
    return value


def load_manifest(work_dir: Path) -> dict[str, Any]:
    manifest = read_json(work_dir / "run-manifest.json", "run manifest")
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        fail("run manifest schemaVersion mismatch")
    return manifest


def load_control(work_dir: Path) -> dict[str, Any]:
    control = read_json(work_dir / "run-control.json", "run control")
    desired = control.get("desiredConcurrency")
    if not isinstance(desired, int) or desired < 1:
        fail("run-control.json desiredConcurrency must be a positive integer")
    if not isinstance(control.get("stopRequested"), bool):
        fail("run-control.json stopRequested must be boolean")
    return control


def read_api_key() -> str:
    direct = os.environ.get("QWEN_API_KEY")
    if direct:
        return direct.strip()
    key_file = os.environ.get("QWEN_API_KEY_FILE")
    if key_file:
        path = Path(key_file)
        if not path.is_file():
            fail(f"QWEN_API_KEY_FILE does not exist: {path}")
        key = path.read_text(encoding="utf-8").strip()
        if not key:
            fail(f"QWEN_API_KEY_FILE is empty: {path}")
        return key
    fail("missing API key: set QWEN_API_KEY or QWEN_API_KEY_FILE")


def validate_input_record(record: dict[str, Any], label: str) -> None:
    if record.get("schemaVersion") != INPUT_SCHEMA:
        fail(f"{label} schemaVersion must be {INPUT_SCHEMA}")
    require_string(record.get("productId"), f"{label}.productId")
    require_string(record.get("inputHash"), f"{label}.inputHash")
    if not isinstance(record.get("llmInput"), dict) or not record["llmInput"]:
        fail(f"{label}.llmInput must be a non-empty object")


def validate_value_code(value: str, label: str) -> None:
    if not value or any(char not in VALUE_CODE_CHARS for char in value):
        fail(f"{label} must be lowercase ASCII [a-z0-9_]+")


def canonical_value_code(raw_value: Any, fallback_label: Any, label: str) -> str:
    """Convert model-facing display text into a stable local query code.

    `valueCode` is a generated local code, not a merchant fact. Qwen sometimes
    emits display-style codes such as "64GB", "black-camo", or leaves the code
    blank while providing a useful label. Canonicalizing those to lowercase
    ASCII keeps the final query contract deterministic without inventing a new
    option value. If neither raw code nor label yields a code, fail loudly.
    """

    source = raw_value if isinstance(raw_value, str) and raw_value.strip() else fallback_label
    text = require_string(source, label)
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    code = VALUE_CODE_PATTERN.sub("_", ascii_text.lower()).strip("_")
    if not code:
        fail(f"{label} cannot be canonicalized to lowercase ASCII [a-z0-9_]+")
    validate_value_code(code, label)
    return code


def validate_option_ref(value: Any, dimensions: set[str], label: str) -> tuple[str, str]:
    if not isinstance(value, dict):
        fail(f"{label} must be an object")
    attribute = require_string(value.get("attributeCode"), f"{label}.attributeCode")
    if attribute not in dimensions:
        fail(f"{label}.attributeCode is not declared in optionDimensions")
    code = canonical_value_code(value.get("valueCode"), value.get("label"), f"{label}.valueCode")
    value["valueCode"] = code
    return attribute, code


def validate_plan(plan: dict[str, Any], product_id: str) -> None:
    if plan.get("schemaVersion") != PLAN_SCHEMA:
        fail(f"{product_id}: plan schemaVersion must be {PLAN_SCHEMA}")
    assumptions = require_list(plan.get("assumptions"), f"{product_id}: assumptions")
    if not assumptions:
        fail(f"{product_id}: assumptions must contain at least one product-specific statement")
    for index, value in enumerate(assumptions, 1):
        require_string(value, f"{product_id}: assumptions[{index}]")
    dimensions_raw = require_list(plan.get("optionDimensions"), f"{product_id}: optionDimensions")
    if len(dimensions_raw) != 2:
        fail(f"{product_id}: optionDimensions must contain exactly two dimensions")
    dimensions: dict[str, set[str]] = {}
    for index, dimension in enumerate(dimensions_raw, 1):
        if not isinstance(dimension, dict):
            fail(f"{product_id}: optionDimensions[{index}] must be an object")
        attribute = require_string(dimension.get("attributeCode"), f"{product_id}: optionDimensions[{index}].attributeCode")
        if attribute not in VALID_DIMENSIONS:
            fail(f"{product_id}: unsupported option dimension {attribute}")
        if attribute in dimensions:
            fail(f"{product_id}: duplicate option dimension {attribute}")
        require_string(dimension.get("label"), f"{product_id}: optionDimensions[{index}].label")
        values_raw = require_list(dimension.get("values"), f"{product_id}: optionDimensions[{index}].values")
        if len(values_raw) < 2 or len(values_raw) > 4:
            fail(f"{product_id}: dimension {attribute} must contain 2 to 4 values")
        value_codes: set[str] = set()
        for value_index, option_value in enumerate(values_raw, 1):
            if not isinstance(option_value, dict):
                fail(f"{product_id}: dimension {attribute} value {value_index} must be an object")
            label = require_string(option_value.get("label"), f"{product_id}: dimension {attribute} label")
            code = canonical_value_code(option_value.get("valueCode"), label, f"{product_id}: dimension {attribute} valueCode")
            option_value["valueCode"] = code
            if code in value_codes:
                fail(f"{product_id}: duplicate valueCode {attribute}.{code}")
            value_codes.add(code)
        dimensions[attribute] = value_codes
    variants_raw = require_list(plan.get("variants"), f"{product_id}: variants")
    if len(variants_raw) not in (2, 3):
        fail(f"{product_id}: variants must contain 2 or 3 entries")
    seen_keys: set[str] = set()
    seen_tuples: set[tuple[tuple[str, str], ...]] = set()
    for index, variant in enumerate(variants_raw, 1):
        if not isinstance(variant, dict):
            fail(f"{product_id}: variant {index} must be an object")
        key = require_string(variant.get("variantPlanKey"), f"{product_id}: variant {index} variantPlanKey")
        if key != f"v{index}" or key in seen_keys:
            fail(f"{product_id}: variantPlanKey must be ordered unique v1/v2/v3")
        seen_keys.add(key)
        require_string(variant.get("titleSuffix"), f"{product_id}: variant {index} titleSuffix")
        require_string(variant.get("merchandisingRationale"), f"{product_id}: variant {index} merchandisingRationale")
        option_values = require_list(variant.get("optionValues"), f"{product_id}: variant {index} optionValues")
        if len(option_values) != 2:
            fail(f"{product_id}: variant {index} must contain exactly two option values")
        tuple_values = []
        for option_index, option_ref in enumerate(option_values, 1):
            attribute, code = validate_option_ref(option_ref, set(dimensions), f"{product_id}: variant {index} option {option_index}")
            if code not in dimensions[attribute]:
                fail(f"{product_id}: variant {index} references undeclared value {attribute}.{code}")
            tuple_values.append((attribute, code))
        if {attribute for attribute, _ in tuple_values} != set(dimensions):
            fail(f"{product_id}: variant {index} does not cover every dimension exactly once")
        tuple_key = tuple(sorted(tuple_values))
        if tuple_key in seen_tuples:
            fail(f"{product_id}: duplicate variant option tuple")
        seen_tuples.add(tuple_key)
    impossible = plan.get("impossibleCombination")
    if not isinstance(impossible, dict):
        fail(f"{product_id}: impossibleCombination must be an object")
    reason = require_string(impossible.get("reason"), f"{product_id}: impossibleCombination.reason")
    if len(reason) < 8:
        fail(f"{product_id}: impossibleCombination.reason is too short")
    impossible_values = require_list(impossible.get("optionValues"), f"{product_id}: impossibleCombination.optionValues")
    if len(impossible_values) != 2:
        fail(f"{product_id}: impossibleCombination must contain exactly two option values")
    impossible_tuple = []
    for option_index, option_ref in enumerate(impossible_values, 1):
        attribute, code = validate_option_ref(option_ref, set(dimensions), f"{product_id}: impossible option {option_index}")
        if code not in dimensions[attribute]:
            fail(f"{product_id}: impossibleCombination references undeclared value {attribute}.{code}")
        impossible_tuple.append((attribute, code))
    if {attribute for attribute, _ in impossible_tuple} != set(dimensions):
        fail(f"{product_id}: impossibleCombination does not cover every dimension")
    if tuple(sorted(impossible_tuple)) in seen_tuples:
        fail(f"{product_id}: impossibleCombination duplicates a generated variant")


def parse_model_json(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if stripped.startswith("```") or stripped.endswith("```"):
        fail("model returned Markdown/code fence instead of raw JSON")
    try:
        value = json.loads(stripped)
    except json.JSONDecodeError as error:
        raise RunnerError(f"model response is not valid JSON: {error}") from error
    if not isinstance(value, dict):
        fail("model response must be a JSON object")
    return value


def call_qwen(api_key: str, base_url: str, model: str, prompt_contract: str, llm_input: dict[str, Any], timeout_seconds: int) -> tuple[dict[str, Any], dict[str, str]]:
    request_body = {
        "model": model,
        "messages": [
            {"role": "system", "content": prompt_contract},
            {"role": "user", "content": canonical_json(llm_input)},
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }
    payload = json.dumps(request_body, ensure_ascii=False).encode("utf-8")
    request_hash = hashlib.sha256(payload).hexdigest()
    request = urllib.request.Request(
        base_url,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            response_bytes = response.read()
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RunnerError(f"Qwen HTTP {error.code}: {body[:2000]}") from error
    except urllib.error.URLError as error:
        raise RunnerError(f"Qwen request failed: {error}") from error
    response_hash = hashlib.sha256(response_bytes).hexdigest()
    try:
        response_json = json.loads(response_bytes.decode("utf-8"))
    except json.JSONDecodeError as error:
        raise RunnerError("Qwen API response is not valid JSON") from error
    choices = response_json.get("choices")
    if not isinstance(choices, list) or not choices:
        fail("Qwen API response has no choices")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        fail("Qwen API response choice has empty content")
    return parse_model_json(content), {"requestHash": request_hash, "responseHash": response_hash}


def command_init(args: argparse.Namespace) -> int:
    work_dir = args.work_dir
    if work_dir.exists() and any(work_dir.iterdir()) and not args.force:
        fail(f"work dir already exists and is not empty: {work_dir}; pass --force to reinitialize explicitly")
    work_dir.mkdir(parents=True, exist_ok=True)
    rows = iter_jsonl(args.input, "prepared input")
    if args.max_products is not None:
        if args.max_products <= 0:
            fail("--max-products must be positive")
        rows = rows[: args.max_products]
    if not rows:
        fail("prepared input contains no rows")
    for index, row in enumerate(rows, 1):
        validate_input_record(row, f"prepared input row {index}")
    if args.shard_count <= 0:
        fail("--shard-count must be positive")
    if args.concurrency <= 0:
        fail("--concurrency must be positive")
    shards_dir = work_dir / "shards"
    shards_dir.mkdir(parents=True, exist_ok=True)
    for shard_index in range(args.shard_count):
        shard_rows = [row for row_index, row in enumerate(rows) if row_index % args.shard_count == shard_index]
        shard_dir = shards_dir / f"shard-{shard_index:04d}"
        shard_dir.mkdir(parents=True, exist_ok=True)
        input_path = shard_dir / "input.jsonl"
        with input_path.open("w", encoding="utf-8", newline="\n") as handle:
            for row in shard_rows:
                handle.write(canonical_json(row) + "\n")
        write_json_atomic(shard_dir / "status.json", {
            "status": "pending",
            "shard": shard_index,
            "productCount": len(shard_rows),
            "createdAt": now_iso(),
        })
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "createdAt": now_iso(),
        "inputPath": str(args.input.resolve()),
        "inputSha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
        "productCount": len(rows),
        "shardCount": args.shard_count,
        "model": args.model,
        "baseUrl": args.base_url,
        "promptContractPath": str((work_dir / "prompt_contract.md").resolve()),
    }
    contract_source = Path(__file__).with_name("prompt_contract.md")
    contract_target = work_dir / "prompt_contract.md"
    if not contract_source.is_file():
        fail(f"prompt contract is missing next to runner: {contract_source}")
    contract_target.write_text(contract_source.read_text(encoding="utf-8"), encoding="utf-8")
    write_json_atomic(work_dir / "run-manifest.json", manifest)
    write_json_atomic(work_dir / "run-control.json", {
        "desiredConcurrency": args.concurrency,
        "stopRequested": False,
        "updatedAt": now_iso(),
    })
    print(f"initialized {len(rows)} products into {args.shard_count} shards at {work_dir}")
    return 0


def summarize_status(work_dir: Path) -> dict[str, Any]:
    manifest = load_manifest(work_dir)
    control = load_control(work_dir)
    counts: dict[str, int] = {}
    products_done = 0
    products_failed = 0
    for status_path in sorted((work_dir / "shards").glob("shard-*/status.json")):
        status = read_json(status_path, f"status {status_path}")
        state = require_string(status.get("status"), f"{status_path}.status")
        counts[state] = counts.get(state, 0) + 1
        products_done += int(status.get("successCount") or 0)
        products_failed += int(status.get("failureCount") or 0)
    return {
        "schemaVersion": "product-eval-v16-status.v1",
        "run": str(work_dir.resolve()),
        "model": manifest["model"],
        "productCount": manifest["productCount"],
        "shardCount": manifest["shardCount"],
        "desiredConcurrency": control["desiredConcurrency"],
        "stopRequested": control["stopRequested"],
        "shardStatusCounts": dict(sorted(counts.items())),
        "productsSucceeded": products_done,
        "productsFailed": products_failed,
        "updatedAt": now_iso(),
    }


def command_status(args: argparse.Namespace) -> int:
    print(json.dumps(summarize_status(args.work_dir), ensure_ascii=False, sort_keys=True, indent=2))
    return 0


def command_set_control(args: argparse.Namespace) -> int:
    control = load_control(args.work_dir)
    if args.concurrency is not None:
        if args.concurrency <= 0:
            fail("--concurrency must be positive")
        control["desiredConcurrency"] = args.concurrency
    if args.stop is not None:
        control["stopRequested"] = args.stop
    control["updatedAt"] = now_iso()
    write_json_atomic(args.work_dir / "run-control.json", control)
    print(json.dumps(control, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


def command_stop(args: argparse.Namespace) -> int:
    args.stop = True
    args.concurrency = None
    return command_set_control(args)


def command_run_shard(args: argparse.Namespace) -> int:
    if args.max_attempts <= 0:
        fail("--max-attempts must be positive")
    work_dir = args.work_dir
    manifest = load_manifest(work_dir)
    shard_dir = work_dir / "shards" / args.shard
    status_path = shard_dir / "status.json"
    status = read_json(status_path, f"{args.shard} status")
    if status.get("status") == "success":
        print(f"{args.shard} is already success; immutable shard skipped")
        return 0
    prompt_contract = (work_dir / "prompt_contract.md").read_text(encoding="utf-8")
    rows = iter_jsonl(shard_dir / "input.jsonl", f"{args.shard} input")
    api_key = read_api_key()
    output_path = shard_dir / "output.jsonl"
    failure_path = shard_dir / "failures.jsonl"
    completed: set[str] = set()
    if output_path.exists():
        for output_index, output in enumerate(iter_jsonl(output_path, f"{args.shard} output"), 1):
            product_id = require_string(output.get("productId"), f"{args.shard} output {output_index}.productId")
            validate_plan(output.get("variantPlan") if isinstance(output.get("variantPlan"), dict) else {}, product_id)
            completed.add(product_id)
    write_json_atomic(status_path, {
        **status,
        "status": "running",
        "startedAt": status.get("startedAt") or now_iso(),
        "updatedAt": now_iso(),
        "successCount": len(completed),
    })
    failures = 0
    for index, record in enumerate(rows, 1):
        product_id = require_string(record.get("productId"), f"{args.shard} row {index}.productId")
        if product_id in completed:
            continue
        control = load_control(work_dir)
        if control["stopRequested"]:
            write_json_atomic(status_path, {
                **read_json(status_path, f"{args.shard} status"),
                "status": "stopped",
                "updatedAt": now_iso(),
                "successCount": len(completed),
                "failureCount": failures,
            })
            print(f"{args.shard} stopped after {len(completed)} successes")
            return 3
        last_error: Exception | None = None
        last_traceback = ""
        for attempt in range(1, args.max_attempts + 1):
            try:
                plan, hashes = call_qwen(
                    api_key=api_key,
                    base_url=str(manifest["baseUrl"]),
                    model=str(manifest["model"]),
                    prompt_contract=prompt_contract,
                    llm_input=record["llmInput"],
                    timeout_seconds=args.timeout_seconds,
                )
                validate_plan(plan, product_id)
                append_jsonl(output_path, {
                    "schemaVersion": "product-eval-v16-variant-plan-result.v1",
                    "productId": product_id,
                    "inputHash": record["inputHash"],
                    "model": manifest["model"],
                    "createdAt": now_iso(),
                    "attempt": attempt,
                    "requestHash": hashes["requestHash"],
                    "responseHash": hashes["responseHash"],
                    "variantPlan": plan,
                })
                completed.add(product_id)
                last_error = None
                break
            except Exception as error:
                last_error = error
                last_traceback = traceback.format_exc(limit=8)
                append_jsonl(failure_path, {
                    "schemaVersion": "product-eval-v16-llm-attempt-failure.v1",
                    "productId": product_id,
                    "inputHash": record.get("inputHash"),
                    "attempt": attempt,
                    "maxAttempts": args.max_attempts,
                    "failedAt": now_iso(),
                    "errorType": type(error).__name__,
                    "error": str(error),
                    "traceback": last_traceback,
                })
                if attempt < args.max_attempts:
                    time.sleep(min(2 * attempt, 10))
        if last_error is not None:
            failures += 1
            append_jsonl(failure_path, {
                "schemaVersion": "product-eval-v16-llm-failure.v1",
                "productId": product_id,
                "inputHash": record.get("inputHash"),
                "failedAt": now_iso(),
                "attempts": args.max_attempts,
                "errorType": type(last_error).__name__,
                "error": str(last_error),
                "traceback": last_traceback,
            })
            write_json_atomic(status_path, {
                **read_json(status_path, f"{args.shard} status"),
                "status": "failed",
                "updatedAt": now_iso(),
                "successCount": len(completed),
                "failureCount": failures,
                "lastError": str(last_error),
            })
            print(f"{args.shard} failed on product {product_id}: {last_error}", file=sys.stderr)
            return 4
        write_json_atomic(status_path, {
            **read_json(status_path, f"{args.shard} status"),
            "status": "running",
            "updatedAt": now_iso(),
            "successCount": len(completed),
            "failureCount": failures,
        })
    if len(completed) != len(rows):
        fail(f"{args.shard} internal mismatch: completed {len(completed)} of {len(rows)}")
    write_json_atomic(status_path, {
        **read_json(status_path, f"{args.shard} status"),
        "status": "success",
        "updatedAt": now_iso(),
        "finishedAt": now_iso(),
        "successCount": len(completed),
        "failureCount": failures,
    })
    print(f"{args.shard} success: {len(completed)} products")
    return 0


def runnable_shards(work_dir: Path) -> list[str]:
    shards: list[str] = []
    for status_path in sorted((work_dir / "shards").glob("shard-*/status.json")):
        status = read_json(status_path, f"status {status_path}")
        if status.get("status") in {"pending", "running", "failed", "stopped"}:
            if status.get("status") != "success":
                shards.append(status_path.parent.name)
    return shards


def command_supervisor(args: argparse.Namespace) -> int:
    if args.max_attempts <= 0:
        fail("--max-attempts must be positive")
    load_manifest(args.work_dir)
    script = Path(__file__).resolve()
    active: dict[str, subprocess.Popen[Any]] = {}
    exit_codes: dict[str, int] = {}
    while True:
        control = load_control(args.work_dir)
        for shard, process in list(active.items()):
            code = process.poll()
            if code is not None:
                exit_codes[shard] = code
                del active[shard]
        if control["stopRequested"]:
            if active:
                print(f"stop requested; waiting for {len(active)} active shard process(es) to stop after current product")
            else:
                break
        capacity = max(0, control["desiredConcurrency"] - len(active))
        if not control["stopRequested"] and capacity > 0:
            for shard in runnable_shards(args.work_dir):
                if shard in active or shard in exit_codes:
                    continue
                if capacity <= 0:
                    break
                process = subprocess.Popen([
                    sys.executable,
                    str(script),
                    "run-shard",
                    "--work-dir",
                    str(args.work_dir),
                    "--shard",
                    shard,
                    "--timeout-seconds",
                    str(args.timeout_seconds),
                    "--max-attempts",
                    str(args.max_attempts),
                ])
                active[shard] = process
                capacity -= 1
                print(f"started {shard} pid={process.pid}")
        if not active:
            remaining = runnable_shards(args.work_dir)
            if not remaining or all(shard in exit_codes for shard in remaining):
                break
        time.sleep(args.poll_seconds)
    failed = {shard: code for shard, code in exit_codes.items() if code != 0}
    print(json.dumps(summarize_status(args.work_dir), ensure_ascii=False, sort_keys=True, indent=2))
    if failed:
        print(f"failed shard exits: {failed}", file=sys.stderr)
        return 5
    return 0


def command_merge(args: argparse.Namespace) -> int:
    manifest = load_manifest(args.work_dir)
    outputs: list[dict[str, Any]] = []
    seen_products: set[str] = set()
    for shard_index in range(int(manifest["shardCount"])):
        shard_dir = args.work_dir / "shards" / f"shard-{shard_index:04d}"
        status = read_json(shard_dir / "status.json", f"shard-{shard_index:04d} status")
        if status.get("status") != "success":
            fail(f"cannot merge: shard-{shard_index:04d} status is {status.get('status')}, not success")
        output_path = shard_dir / "output.jsonl"
        rows = iter_jsonl(output_path, f"shard-{shard_index:04d} output")
        for row_index, row in enumerate(rows, 1):
            product_id = require_string(row.get("productId"), f"{output_path} line {row_index} productId")
            if product_id in seen_products:
                fail(f"duplicate productId in outputs: {product_id}")
            plan = row.get("variantPlan")
            if not isinstance(plan, dict):
                fail(f"{output_path} line {row_index} variantPlan must be object")
            validate_plan(plan, product_id)
            seen_products.add(product_id)
            outputs.append(row)
    if len(outputs) != int(manifest["productCount"]):
        fail(f"merged output count {len(outputs)} does not match manifest productCount {manifest['productCount']}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8", newline="\n") as handle:
        for row in sorted(outputs, key=lambda value: value["productId"]):
            handle.write(canonical_json(row) + "\n")
    print(f"merged {len(outputs)} variant plans to {args.output}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="Create run manifest, control file, and shard inputs")
    init.add_argument("--input", required=True, type=Path, help="Prepared sanitized JSONL from prepare_input_from_normalized.py")
    init.add_argument("--work-dir", required=True, type=Path)
    init.add_argument("--shard-count", required=True, type=int)
    init.add_argument("--concurrency", required=True, type=int)
    init.add_argument("--model", default=DEFAULT_MODEL)
    init.add_argument("--base-url", default=DEFAULT_BASE_URL)
    init.add_argument("--max-products", type=int)
    init.add_argument("--force", action="store_true")
    init.set_defaults(func=command_init)

    status = sub.add_parser("status", help="Print run status JSON")
    status.add_argument("--work-dir", required=True, type=Path)
    status.set_defaults(func=command_status)

    set_control = sub.add_parser("set-control", help="Change desired concurrency and/or stop flag")
    set_control.add_argument("--work-dir", required=True, type=Path)
    set_control.add_argument("--concurrency", type=int)
    set_control.add_argument("--stop", choices=["true", "false"])
    set_control.set_defaults(func=lambda args: command_set_control(args))

    stop = sub.add_parser("stop", help="Request a graceful stop")
    stop.add_argument("--work-dir", required=True, type=Path)
    stop.set_defaults(func=command_stop)

    supervisor = sub.add_parser("supervisor", help="Run shard workers with dynamic concurrency from run-control.json")
    supervisor.add_argument("--work-dir", required=True, type=Path)
    supervisor.add_argument("--poll-seconds", type=float, default=5.0)
    supervisor.add_argument("--timeout-seconds", type=int, default=120)
    supervisor.add_argument("--max-attempts", type=int, default=3)
    supervisor.set_defaults(func=command_supervisor)

    run_shard = sub.add_parser("run-shard", help="Run one shard")
    run_shard.add_argument("--work-dir", required=True, type=Path)
    run_shard.add_argument("--shard", required=True)
    run_shard.add_argument("--timeout-seconds", type=int, default=120)
    run_shard.add_argument("--max-attempts", type=int, default=3)
    run_shard.set_defaults(func=command_run_shard)

    merge = sub.add_parser("merge", help="Merge only fully successful immutable shards")
    merge.add_argument("--work-dir", required=True, type=Path)
    merge.add_argument("--output", required=True, type=Path)
    merge.set_defaults(func=command_merge)
    return parser


def main(argv: list[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if hasattr(args, "stop") and isinstance(args.stop, str):
        args.stop = args.stop == "true"
    return args.func(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except RunnerError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(2)
