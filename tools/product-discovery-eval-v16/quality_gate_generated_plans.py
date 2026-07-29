#!/usr/bin/env python3
"""Build a partial product-ready quality bundle for generated v16 variant plans.

This script is intentionally fail-loud. It does not modify original shard
outputs. It writes derived acceptance/quarantine artifacts under the run
directory.
"""

from __future__ import annotations

import argparse
import copy
import csv
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
from collections import Counter, defaultdict
from typing import Any


EXPECTED_TOP = {
    "schemaVersion",
    "createdAt",
    "inputHash",
    "model",
    "productId",
    "requestHash",
    "responseHash",
    "variantPlan",
}
EXPECTED_PLAN = {
    "schemaVersion",
    "optionDimensions",
    "variants",
    "impossibleCombination",
    "assumptions",
}
EXPECTED_DIMENSION = {"attributeCode", "label", "values"}
EXPECTED_DIMENSION_VALUE = {"label", "valueCode"}
EXPECTED_VARIANT = {"variantPlanKey", "titleSuffix", "optionValues", "merchandisingRationale"}
EXPECTED_OPTION_REF = {"attributeCode", "valueCode"}
EXPECTED_IMPOSSIBLE = {"optionValues", "reason"}

URL_RE = re.compile(r"https?://|www\.", re.I)
HARD_SOURCE_RE = re.compile(
    r"\b(source id|sourceid|source handle|merchant says|seller says|listed by)\b",
    re.I,
)
UNFRAMED_AVAILABILITY_RE = re.compile(
    r"\b(real[- ]world|actually available|currently available)\b",
    re.I,
)
SYNTHETIC_FRAMING_RE = re.compile(r"\bsynthetic\b|\bevaluation\b|\bintentionally excluded\b", re.I)
FORBIDDEN_KEY_RE = re.compile(r"(source|url|uri|href|handle|sku|price|inventory|offer|provenance|raw)", re.I)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def parse_bool(value: Any) -> bool | None:
    if value in ("true", "t", "True", True):
        return True
    if value in ("false", "f", "False", False):
        return False
    return None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_runner_validate_plan(tools_dir: Path):
    runner_path = tools_dir / "llm_variant_plan_runner.py"
    if not runner_path.is_file():
        raise SystemExit(f"runner not found: {runner_path}")
    spec = importlib.util.spec_from_file_location("llm_variant_plan_runner", runner_path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot import runner: {runner_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not hasattr(module, "validate_plan"):
        raise SystemExit("runner does not expose validate_plan")
    return module.validate_plan


def load_prepared_input(input_path: Path) -> dict[str, dict[str, Any]]:
    prepared: dict[str, dict[str, Any]] = {}
    with input_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            product_id = row.get("productId")
            input_hash = row.get("inputHash")
            if not isinstance(product_id, str) or not isinstance(input_hash, str):
                raise SystemExit(f"bad prepared input envelope at line {line_number}")
            if product_id in prepared:
                raise SystemExit(f"duplicate productId in prepared input: {product_id}")
            prepared[product_id] = {
                "inputHash": input_hash,
                "sourceLine": row.get("sourceLine"),
            }
    return prepared


def load_db_quality_map() -> dict[str, dict[str, str]]:
    required = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_SSL_MODE", "PGPASSWORD"]
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise SystemExit("missing DB environment variables: " + ", ".join(missing))

    sql = r'''COPY (
 SELECT "productId" AS product_id,
        "categoryCode" AS category_code,
        "productTypeCode" AS product_type_code,
        "isCanonicalProduct"::text AS is_canonical_product,
        "semanticDuplicateGroupSize"::text AS semantic_duplicate_group_size,
        CASE WHEN jsonb_typeof(attributes)='array' THEN jsonb_array_length(attributes)::text ELSE '' END AS attributes_count,
        "contentQuality"->>'variantSpecUsable' AS source_variant_spec_usable,
        "contentQuality"->>'structuredAttributesUsable' AS structured_attributes_usable
 FROM eval.products
) TO STDOUT WITH CSV HEADER'''
    connection = (
        f"host={os.environ['DB_HOST']} port={os.environ['DB_PORT']} "
        f"dbname={os.environ['DB_NAME']} user={os.environ['DB_USER']} "
        f"sslmode={os.environ['DB_SSL_MODE']}"
    )
    process = subprocess.run(
        ["psql", connection, "-c", sql],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if process.returncode != 0:
        raise SystemExit("psql quality map query failed: " + process.stderr[-1000:])

    identity = subprocess.run(
        ["psql", connection, "-Atc", "select current_user, current_setting('transaction_read_only')"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if identity.returncode != 0:
        raise SystemExit("psql identity/read-only check failed: " + identity.stderr[-1000:])
    if identity.stdout.strip() != "eval_reader|on":
        raise SystemExit(f"DB connection must be eval_reader and read-only, got: {identity.stdout.strip()}")

    quality = {row["product_id"]: row for row in csv.DictReader(io.StringIO(process.stdout))}
    if len(quality) != 100000:
        raise SystemExit(f"unexpected DB quality row count: {len(quality)}")
    return quality


def clean_record(raw: dict[str, Any]) -> tuple[dict[str, Any], Counter[str]]:
    cleaned = copy.deepcopy(raw)
    actions: Counter[str] = Counter()

    if "attempt" in cleaned:
        cleaned.pop("attempt")
        actions["removed_top_attempt"] += 1

    plan = cleaned.get("variantPlan")
    if isinstance(plan, dict):
        for dimension in plan.get("optionDimensions") or []:
            if not isinstance(dimension, dict):
                continue
            for option_value in dimension.get("values") or []:
                if isinstance(option_value, dict) and "attributeCode" in option_value:
                    option_value.pop("attributeCode")
                    actions["removed_dimension_value_attributeCode"] += 1
                if isinstance(option_value, dict) and "value_code" in option_value:
                    option_value.pop("value_code")
                    actions["removed_dimension_value_value_code"] += 1

        def frame_text(value: Any, prefix: str) -> Any:
            if not isinstance(value, str) or SYNTHETIC_FRAMING_RE.search(value):
                return value
            actions["added_synthetic_framing"] += 1
            return prefix + value

        assumptions = plan.get("assumptions")
        if isinstance(assumptions, list):
            plan["assumptions"] = [
                frame_text(item, "Synthetic evaluation assumption: ") for item in assumptions
            ]

        for variant in plan.get("variants") or []:
            if isinstance(variant, dict):
                variant["merchandisingRationale"] = frame_text(
                    variant.get("merchandisingRationale"),
                    "Synthetic evaluation rationale: ",
                )
                for option_ref in variant.get("optionValues") or []:
                    if isinstance(option_ref, dict) and "label" in option_ref:
                        option_ref.pop("label")
                        actions["removed_variant_option_label"] += 1

        impossible = plan.get("impossibleCombination")
        if isinstance(impossible, dict):
            impossible["reason"] = frame_text(
                impossible.get("reason"),
                "Synthetic evaluation constraint: ",
            )
            for option_ref in impossible.get("optionValues") or []:
                if isinstance(option_ref, dict) and "label" in option_ref:
                    option_ref.pop("label")
                    actions["removed_impossible_option_label"] += 1

    return cleaned, actions


def exact_keys(value: Any, expected: set[str], label: str, reasons: list[str]) -> None:
    if not isinstance(value, dict):
        reasons.append(f"{label}:not_object")
        return
    extra = sorted(set(value) - expected)
    missing = sorted(expected - set(value))
    if extra:
        reasons.append(f"{label}:extra_keys={','.join(extra[:8])}")
    if missing:
        reasons.append(f"{label}:missing_keys={','.join(missing[:8])}")


def walk_json(value: Any, path: str = "$"):
    if isinstance(value, dict):
        for key, child in value.items():
            yield path, key, child
            yield from walk_json(child, path + "." + str(key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk_json(child, f"{path}[{index}]")


def validate_exact_and_leak_checks(row: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    exact_keys(row, EXPECTED_TOP, "top", reasons)
    plan = row.get("variantPlan")
    exact_keys(plan, EXPECTED_PLAN, "variantPlan", reasons)
    if not isinstance(plan, dict):
        return reasons

    for index, dimension in enumerate(plan.get("optionDimensions") or []):
        exact_keys(dimension, EXPECTED_DIMENSION, f"optionDimensions[{index}]", reasons)
        for value_index, option_value in enumerate((dimension or {}).get("values") or []):
            exact_keys(
                option_value,
                EXPECTED_DIMENSION_VALUE,
                f"optionDimensions[{index}].values[{value_index}]",
                reasons,
            )

    for index, variant in enumerate(plan.get("variants") or []):
        exact_keys(variant, EXPECTED_VARIANT, f"variants[{index}]", reasons)
        for option_index, option_ref in enumerate((variant or {}).get("optionValues") or []):
            exact_keys(
                option_ref,
                EXPECTED_OPTION_REF,
                f"variants[{index}].optionValues[{option_index}]",
                reasons,
            )

    impossible = plan.get("impossibleCombination")
    exact_keys(impossible, EXPECTED_IMPOSSIBLE, "impossibleCombination", reasons)
    if isinstance(impossible, dict):
        for option_index, option_ref in enumerate(impossible.get("optionValues") or []):
            exact_keys(
                option_ref,
                EXPECTED_OPTION_REF,
                f"impossibleCombination.optionValues[{option_index}]",
                reasons,
            )

    for path, key, value in walk_json(plan):
        if isinstance(key, str) and FORBIDDEN_KEY_RE.search(key):
            reasons.append(f"forbidden_key:{path}.{key}")
            if isinstance(value, str):
                if URL_RE.search(value):
                    reasons.append(f"url_in_text:{path}.{key}")
                if HARD_SOURCE_RE.search(value):
                    reasons.append(f"hard_source_claim:{path}.{key}")
                if UNFRAMED_AVAILABILITY_RE.search(value) and not SYNTHETIC_FRAMING_RE.search(value):
                    reasons.append(f"unframed_availability_claim:{path}.{key}")
    return reasons


def read_shard_inputs(run_dir: Path, prepared: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    shard_inputs: dict[str, dict[str, Any]] = {}
    for input_path in sorted((run_dir / "shards").glob("*/input.jsonl")):
        status_path = input_path.parent / "status.json"
        if not status_path.is_file():
            raise SystemExit(f"missing shard status file: {status_path}")
        try:
            shard_status = json.loads(status_path.read_text(encoding="utf-8")).get("status")
        except Exception as exc:
            raise SystemExit(f"invalid shard status JSON: {status_path}: {exc}") from exc
        with input_path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    raise SystemExit(f"blank shard input line: {input_path}:{line_number}")
                try:
                    row = json.loads(line)
                except Exception as exc:
                    raise SystemExit(f"invalid shard input JSON: {input_path}:{line_number}: {exc}") from exc
                product_id = row.get("productId")
                input_hash = row.get("inputHash")
                if not isinstance(product_id, str) or not isinstance(input_hash, str):
                    raise SystemExit(f"bad shard input envelope: {input_path}:{line_number}")
                if product_id not in prepared:
                    raise SystemExit(f"shard input productId not in prepared input: {product_id} at {input_path}:{line_number}")
                if input_hash != prepared[product_id]["inputHash"]:
                    raise SystemExit(f"shard inputHash mismatch for {product_id}: {input_path}:{line_number}")
                if product_id in shard_inputs:
                    raise SystemExit(f"duplicate productId across shard inputs: {product_id}")
                shard_inputs[product_id] = {
                    "inputHash": input_hash,
                    "shard": input_path.parent.name,
                    "shardStatus": shard_status,
                    "sourceLine": prepared[product_id].get("sourceLine"),
                }
    missing = sorted(set(prepared) - set(shard_inputs))
    if missing:
        raise SystemExit(f"prepared products missing from shard inputs: count={len(missing)} first={missing[:5]}")
    return shard_inputs


def read_output_records(run_dir: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for output_path in sorted((run_dir / "shards").glob("*/output.jsonl")):
        status_path = output_path.parent / "status.json"
        if not status_path.is_file():
            raise SystemExit(f"missing shard status file: {status_path}")
        try:
            shard_status = json.loads(status_path.read_text(encoding="utf-8")).get("status")
        except Exception as exc:
            raise SystemExit(f"invalid shard status JSON: {status_path}: {exc}") from exc
        with output_path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    raise SystemExit(f"blank output line: {output_path}:{line_number}")
                try:
                    row = json.loads(line)
                except Exception as exc:
                    raise SystemExit(f"invalid output JSON: {output_path}:{line_number}: {exc}") from exc
                records.append(
                    {
                        "row": row,
                        "file": str(output_path),
                        "line": line_number,
                        "shard": output_path.parent.name,
                        "shardStatus": shard_status,
                    }
                )
    return records


def enforce_output_invariants(records: list[dict[str, Any]], prepared: dict[str, dict[str, Any]]) -> Counter[str]:
    seen: dict[str, dict[str, Any]] = {}
    shard_status_counts: Counter[str] = Counter()
    for record in records:
        row = record["row"]
        shard_status_counts[str(record["shardStatus"])] += 1
        if not isinstance(row, dict):
            raise SystemExit(f"output row must be an object: {record['file']}:{record['line']}")
        if row.get("schemaVersion") != "product-eval-v16-variant-plan-result.v1":
            raise SystemExit(f"bad output schemaVersion: {record['file']}:{record['line']}")
        product_id = row.get("productId")
        input_hash = row.get("inputHash")
        if not isinstance(product_id, str) or not isinstance(input_hash, str):
            raise SystemExit(f"bad output envelope: {record['file']}:{record['line']}")
        if product_id not in prepared:
            raise SystemExit(f"output productId not in prepared input: {product_id} at {record['file']}:{record['line']}")
        if input_hash != prepared[product_id]["inputHash"]:
            raise SystemExit(f"output inputHash mismatch for {product_id}: {record['file']}:{record['line']}")
        if product_id in seen:
            first = seen[product_id]
            raise SystemExit(
                "duplicate output productId: "
                f"{product_id}; first={first['file']}:{first['line']} second={record['file']}:{record['line']}"
            )
        seen[product_id] = record
    return shard_status_counts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--tools-dir", required=True)
    parser.add_argument("--mode", choices=["product-ready", "strict-source"], default="product-ready")
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    run_dir = Path(args.run_dir)
    output_dir = (
        Path(args.output_dir)
        if args.output_dir
        else run_dir / "quality" / f"partial-{args.mode}-{dt.datetime.now(dt.UTC).strftime('%Y%m%dT%H%M%SZ')}"
    )
    output_dir.mkdir(parents=True, exist_ok=False)

    validate_plan = load_runner_validate_plan(Path(args.tools_dir))
    prepared = load_prepared_input(Path(args.input))
    quality = load_db_quality_map()
    shard_inputs = read_shard_inputs(run_dir, prepared)
    records = read_output_records(run_dir)
    shard_output_status_counts = enforce_output_invariants(records, prepared)

    seen: defaultdict[Any, int] = defaultdict(int)
    for record in records:
        seen[record["row"].get("productId")] += 1

    accepted: list[dict[str, Any]] = []
    quarantine: list[dict[str, Any]] = []
    rerun: list[dict[str, Any]] = []
    reason_counts: Counter[str] = Counter()
    warning_counts: Counter[str] = Counter()
    cleaning_actions: Counter[str] = Counter()
    category_counts: Counter[str] = Counter()
    axis_counts: Counter[str] = Counter()
    variant_count_distribution: Counter[int] = Counter()
    accepted_pre_llm_spec_false = 0

    for record in records:
        raw = record["row"]
        row, actions = clean_record(raw)
        cleaning_actions.update(actions)
        product_id = row.get("productId")
        reasons: list[str] = []
        warnings: list[str] = []

        if not isinstance(product_id, str):
            reasons.append("missing_or_invalid_productId")
        elif seen[product_id] > 1:
            reasons.append("duplicate_output_productId")
        if record["shardStatus"] != "success":
            reasons.append("non_success_shard_partial_output")

        prepared_record = prepared.get(product_id) if isinstance(product_id, str) else None
        if prepared_record is None:
            reasons.append("product_not_in_prepared_input")
        elif row.get("inputHash") != prepared_record["inputHash"]:
            reasons.append("input_hash_mismatch")

        quality_record = quality.get(product_id) if isinstance(product_id, str) else None
        source_base_ok = False
        if quality_record is None:
            reasons.append("missing_db_quality_record")
        else:
            category_counts[quality_record.get("category_code") or "unknown"] += 1
            if parse_bool(quality_record.get("structured_attributes_usable")) is not True:
                reasons.append("source_structuredAttributesUsable_not_true")
            try:
                if int(quality_record.get("attributes_count") or "0") <= 0:
                    reasons.append("source_attributes_empty")
            except ValueError:
                reasons.append("source_attributes_count_invalid")
            if parse_bool(quality_record.get("is_canonical_product")) is not True:
                reasons.append("source_isCanonicalProduct_not_true")
            try:
                if int(quality_record.get("semantic_duplicate_group_size") or "999999") > 1:
                    reasons.append("source_semanticDuplicateGroupSize_gt_1")
            except ValueError:
                reasons.append("source_semanticDuplicateGroupSize_invalid")
            if args.mode == "strict-source":
                if parse_bool(quality_record.get("source_variant_spec_usable")) is not True:
                    reasons.append("source_variantSpecUsable_not_true")
            elif parse_bool(quality_record.get("source_variant_spec_usable")) is not True:
                warnings.append("source_variantSpecUsable_pre_llm_false_generated_plan_used")
            source_base_ok = not any(reason.startswith("source_") for reason in reasons)

        try:
            validate_plan(
                row.get("variantPlan") if isinstance(row.get("variantPlan"), dict) else {},
                product_id if isinstance(product_id, str) else "<missing>",
            )
        except Exception as exc:
            reasons.append("plan_contract_invalid:" + str(exc)[:180].replace("\n", " "))

        reasons.extend(validate_exact_and_leak_checks(row))

        plan = row.get("variantPlan") if isinstance(row.get("variantPlan"), dict) else {}
        for dimension in plan.get("optionDimensions") or []:
            if isinstance(dimension, dict) and isinstance(dimension.get("attributeCode"), str):
                axis_counts[dimension["attributeCode"]] += 1
        variant_count_distribution[len(plan.get("variants") or [])] += 1

        for reason in reasons:
            reason_counts[reason.split(":", 1)[0]] += 1
        for warning in warnings:
            warning_counts[warning.split(":", 1)[0]] += 1

        gate = {
            "schemaVersion": "product-eval-v16-partial-product-ready-gate.v1",
            "checkedAt": utc_now(),
            "mode": args.mode,
            "specUsableForTask": (
                "generated_variant_plan_contract_valid"
                if args.mode == "product-ready"
                else "source_content_quality_variantSpecUsable"
            ),
            "sourceEligibility": quality_record,
            "reasons": reasons,
            "warnings": warnings,
            "cleanedFromRawOutput": row != raw,
            "sourceFile": record["file"],
            "sourceLine": record["line"],
            "shard": record["shard"],
            "shardStatus": record["shardStatus"],
        }
        wrapped = {"qualityGate": gate, "record": row}
        if reasons:
            quarantine.append(wrapped)
            if source_base_ok and any(
                reason.startswith(
                    (
                        "plan_contract_invalid",
                        "top:",
                        "variantPlan:",
                        "forbidden_key",
                        "url_in_text",
                        "hard_truth_or_source_claim",
                        "non_success_shard_partial_output",
                        "input_hash_mismatch",
                        "product_not_in_prepared_input",
                        "duplicate_output_productId",
                    )
                )
                for reason in reasons
            ):
                rerun.append(
                    {
                        "productId": product_id,
                        "inputHash": row.get("inputHash"),
                        "reasons": reasons,
                        "sourceFile": record["file"],
                        "sourceLine": record["line"],
                    }
                )
        else:
            if (
                quality_record is not None
                and parse_bool(quality_record.get("source_variant_spec_usable")) is not True
            ):
                accepted_pre_llm_spec_false += 1
            accepted.append(wrapped)

    generated_product_ids = {
        record["row"]["productId"]
        for record in records
        if isinstance(record.get("row"), dict) and isinstance(record["row"].get("productId"), str)
    }
    for product_id in sorted(set(prepared) - generated_product_ids):
        shard_input = shard_inputs[product_id]
        reason_counts["missing_output_needs_generation"] += 1
        rerun.append(
            {
                "productId": product_id,
                "inputHash": prepared[product_id]["inputHash"],
                "reasons": ["missing_output_needs_generation"],
                "sourceLine": prepared[product_id].get("sourceLine"),
                "shard": shard_input["shard"],
                "shardStatus": shard_input["shardStatus"],
            }
        )

    files = {
        "accepted": output_dir / f"accepted.{args.mode}.partial.jsonl",
        "quarantine": output_dir / f"quarantined.{args.mode}.partial.jsonl",
        "rerun": output_dir / f"needs-rerun.{args.mode}.partial.jsonl",
        "report_json": output_dir / f"qc-report.{args.mode}.partial.json",
        "report_md": output_dir / f"qc-report.{args.mode}.partial.md",
    }
    for key, items in (("accepted", accepted), ("quarantine", quarantine), ("rerun", rerun)):
        with files[key].open("w", encoding="utf-8") as handle:
            for item in items:
                handle.write(canonical_json(item) + "\n")

    report = {
        "schemaVersion": "product-eval-v16-partial-product-ready-report.v1",
        "mode": args.mode,
        "run": str(run_dir),
        "input": str(Path(args.input)),
        "createdAt": utc_now(),
        "interpretation": (
            "product-ready mode derives specUsableForTask from the validated cleaned LLM "
            "variant plan; source contentQuality.variantSpecUsable is retained as a "
            "pre-LLM warning only. structuredAttributes/canonical/nonDuplicate remain "
            "DB source hard gates."
        ),
        "recordCounts": {
            "preparedInputProducts": len(prepared),
            "dbQualityRows": len(quality),
            "outputRowsParsed": len(records),
            "jsonErrors": 0,
            "uniqueOutputProductIds": len(seen),
            "accepted": len(accepted),
            "quarantined": len(quarantine),
            "needsRerun": len(rerun),
            "acceptedWithPreLlmSourceVariantSpecFalse": accepted_pre_llm_spec_false,
        },
        "shardOutputStatusCounts": dict(shard_output_status_counts.most_common()),
        "reasonCounts": dict(reason_counts.most_common()),
        "warningCounts": dict(warning_counts.most_common()),
        "cleaningActions": dict(cleaning_actions.most_common()),
        "categoryCountsAllParsed": dict(category_counts.most_common()),
        "axisCountsAllParsed": dict(axis_counts.most_common()),
        "variantCountDistributionAllParsed": dict(variant_count_distribution.most_common()),
        "files": {key: str(path) for key, path in files.items()},
        "sha256": {},
    }
    for key, path in files.items():
        if key in {"report_json", "report_md"}:
            continue
        report["sha256"][key] = sha256_file(path)

    files["report_json"].write_text(
        json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    files["report_md"].write_text(
        "\n".join(
            [
                "# v16 partial product-ready generated plan quality report",
                "",
                f"- Mode: `{args.mode}`",
                f"- Run: `{run_dir}`",
                f"- CreatedAt: `{report['createdAt']}`",
                f"- Parsed output rows: {len(records)}",
                f"- Accepted: {len(accepted)}",
                f"- Quarantined: {len(quarantine)}",
                f"- Needs rerun: {len(rerun)}",
                f"- Accepted with pre-LLM source variantSpecUsable=false: {accepted_pre_llm_spec_false}",
                "",
                "## Hard-fail reasons",
                *[f"- {key}: {value}" for key, value in reason_counts.most_common(20)],
                "",
                "## Warnings",
                *[f"- {key}: {value}" for key, value in warning_counts.most_common(20)],
                "",
                "## Cleaning actions",
                *[f"- {key}: {value}" for key, value in cleaning_actions.most_common(20)],
                "",
                "## Output files",
                *[f"- {key}: `{value}`" for key, value in report["files"].items()],
                "",
            ]
        ),
        encoding="utf-8",
    )
    report["sha256"]["report_md"] = sha256_file(files["report_md"])
    report["reportJsonSha256Policy"] = (
        "omitted from embedded sha256 map because a report cannot contain a stable hash of itself"
    )
    files["report_json"].write_text(
        json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
