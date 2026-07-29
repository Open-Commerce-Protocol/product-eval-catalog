#!/usr/bin/env python3
"""Prepare sanitized Product inputs for the v16 Qwen variant-plan runner.

This script reads normalized Product JSONL and emits one local envelope per
Product. The local envelope retains productId for resumability and later
binding, but productId and source/provenance fields are removed from the LLM
payload.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable


FORBIDDEN_KEY_PATTERN = re.compile(
    r"(^|[_\-.])("
    r"id|ids|url|urls|uri|uris|href|link|links|handle|handles|"
    r"source|sourceid|sourceids|sourcekey|sourcekeys|provenance|"
    r"external|externalid|externalids|origin|raw"
    r")($|[_\-.])",
    re.IGNORECASE,
)
URL_PATTERN = re.compile(r"https?://|www\.", re.IGNORECASE)
HANDLE_PATTERN = re.compile(r"(^|[^A-Za-z0-9])@[A-Za-z0-9_][A-Za-z0-9_.-]{1,}", re.ASCII)


class PrepareError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise PrepareError(message)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def read_jsonl(path: Path) -> Iterable[tuple[int, dict[str, Any]]]:
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                fail(f"{path} contains a blank line at {line_number}")
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise PrepareError(f"{path} contains invalid JSON at line {line_number}") from error
            if not isinstance(value, dict):
                fail(f"{path} line {line_number} must be a JSON object")
            yield line_number, value


def get_path(record: dict[str, Any], path: str, label: str) -> Any:
    current: Any = record
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            fail(f"{label} path '{path}' is missing")
        current = current[part]
    return current


def require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{label} must be a non-empty string")
    return value.strip()


def key_is_forbidden(key: str) -> bool:
    compact = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", key).lower()
    return bool(FORBIDDEN_KEY_PATTERN.search(compact))


def sanitize(value: Any, path: str) -> Any:
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, child in value.items():
            if not isinstance(key, str) or not key:
                fail(f"{path} contains a non-string or empty object key")
            if key_is_forbidden(key):
                continue
            cleaned = sanitize(child, f"{path}.{key}")
            if cleaned is not None:
                sanitized[key] = cleaned
        return sanitized or None
    if isinstance(value, list):
        cleaned_list = [sanitize(child, f"{path}[]") for child in value]
        sanitized_list = [child for child in cleaned_list if child is not None]
        return sanitized_list or None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if URL_PATTERN.search(text) or HANDLE_PATTERN.search(text):
            return None
        return text
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    fail(f"{path} contains unsupported value type {type(value).__name__}")


def assert_no_forbidden_payload(value: Any, path: str) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key_is_forbidden(key):
                fail(f"{path}.{key} still contains forbidden identifier/provenance key")
            assert_no_forbidden_payload(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            assert_no_forbidden_payload(child, f"{path}[{index}]")
    elif isinstance(value, str):
        if URL_PATTERN.search(value) or HANDLE_PATTERN.search(value):
            fail(f"{path} still contains a URL")
        if HANDLE_PATTERN.search(value):
            fail(f"{path} still contains a handle")


def maybe_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or URL_PATTERN.search(text) or HANDLE_PATTERN.search(text):
        return None
    return text


def maybe_number(value: Any) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    return None


def put_text(target: dict[str, Any], key: str, value: Any) -> None:
    text = maybe_text(value)
    if text is not None:
        target[key] = text


def put_number(target: dict[str, Any], key: str, value: Any) -> None:
    number = maybe_number(value)
    if number is not None:
        target[key] = number


def build_llm_input(record: dict[str, Any], line_number: int) -> dict[str, Any]:
    """Build a positive whitelist payload for Qwen.

    The normalized source rows contain useful Product semantics mixed with
    source identifiers, URLs, handles, fingerprints, provenance and evidence.
    Sending the whole row through a blacklist is too risky, so this function
    explicitly extracts only fields that help infer plausible variant axes.
    """

    product = record.get("product")
    if not isinstance(product, dict):
        fail(f"line {line_number} product must be an object")
    variant = record.get("variant")
    if variant is not None and not isinstance(variant, dict):
        fail(f"line {line_number} variant must be an object when present")
    offer = record.get("offer")
    if offer is not None and not isinstance(offer, dict):
        fail(f"line {line_number} offer must be an object when present")

    product_input: dict[str, Any] = {}
    for key in (
        "categoryCode",
        "productTypeCode",
        "categoryNameZh",
        "categoryNameEn",
        "productTypeNameZh",
        "productTypeNameEn",
        "normalizedBrand",
        "brandName",
        "normalizedTitle",
        "titleZh",
        "titleEn",
        "normalizedDescription",
        "descriptionZh",
        "descriptionEn",
    ):
        put_text(product_input, key, product.get(key))

    variant_context: dict[str, Any] = {}
    if isinstance(variant, dict):
        put_text(variant_context, "observedTitle", variant.get("title"))
        put_text(variant_context, "observedDescription", variant.get("description"))
        put_text(variant_context, "observedBrand", variant.get("brand"))
        put_text(variant_context, "observedMerchantCategory", variant.get("sourceCategory"))

    offer_context: dict[str, Any] = {}
    if isinstance(offer, dict):
        put_number(offer_context, "basePrice", offer.get("price"))
        put_text(offer_context, "currency", offer.get("currency"))
        put_text(offer_context, "inventoryStatus", offer.get("inventoryStatus"))
        if isinstance(offer.get("isSaleable"), bool):
            offer_context["isSaleable"] = offer["isSaleable"]

    llm_input: dict[str, Any] = {"product": product_input}
    if variant_context:
        llm_input["observedVariantContext"] = variant_context
    if offer_context:
        llm_input["offerContext"] = offer_context
    if not product_input:
        fail(f"line {line_number} product payload became empty after whitelist extraction")
    return llm_input


def build_envelope(record: dict[str, Any], line_number: int, product_id_path: str) -> dict[str, Any]:
    product_id = require_string(get_path(record, product_id_path, "product id"), f"line {line_number} product id")
    llm_input = build_llm_input(record, line_number)
    if not isinstance(llm_input, dict) or not llm_input:
        fail(f"line {line_number} sanitized payload is empty or is not an object")
    assert_no_forbidden_payload(llm_input, f"line {line_number} llmInput")
    input_hash = hashlib.sha256(canonical_json(llm_input).encode("utf-8")).hexdigest()
    return {
        "schemaVersion": "product-eval-v16-llm-input.v1",
        "productId": product_id,
        "inputHash": input_hash,
        "sourceLine": line_number,
        "llmInput": llm_input,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Normalized Product JSONL path")
    parser.add_argument("--output", required=True, type=Path, help="Sanitized output JSONL path")
    parser.add_argument(
        "--product-id-path",
        default="productId",
        help="Dot path for local product id in normalized JSONL. This value is retained only in the local envelope.",
    )
    parser.add_argument("--limit", type=int, help="Optional explicit local dry-run limit")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.limit is not None and args.limit <= 0:
        fail("--limit must be positive when provided")
    if not args.input.is_file():
        fail(f"input file does not exist: {args.input}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    seen_product_ids: set[str] = set()
    count = 0
    duplicate_product_rows = 0
    with args.output.open("w", encoding="utf-8", newline="\n") as output:
        for line_number, record in read_jsonl(args.input):
            if args.limit is not None and count >= args.limit:
                break
            envelope = build_envelope(record, line_number, args.product_id_path)
            product_id = envelope["productId"]
            if product_id in seen_product_ids:
                duplicate_product_rows += 1
                continue
            seen_product_ids.add(product_id)
            output.write(canonical_json(envelope) + "\n")
            count += 1
    if count == 0:
        fail("no products were written")
    print(
        f"wrote {count} sanitized product inputs to {args.output}; "
        f"skipped_duplicate_product_rows={duplicate_product_rows}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except PrepareError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(2)
