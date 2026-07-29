# Product Eval v16 Qwen Variant Plan Contract

This prompt contract is for Qwen `qwen3.7-plus`. The runner sends one sanitized
Product context at a time. The context intentionally excludes source IDs, URLs,
handles, source keys, source record identifiers, and any other provenance
handles. Do not ask for them and do not invent them.

## Task

Generate a synthetic evaluation variant plan for the given Product. The plan is
not merchant truth, not a database row, and not a final public entity. It is a
strict JSON proposal that later local tooling may bind to immutable Product IDs,
generate canonical local identifiers, attach explicit synthetic provenance, and
validate before any database publication.

## Output rules

Return exactly one JSON object. Do not wrap it in Markdown. Do not include
comments, trailing commas, explanatory prose, JSON schema text, or code fences.

The JSON object must match this structure exactly:

```json
{
  "schemaVersion": "product-eval-variant-plan.v1",
  "assumptions": [
    "short product-specific assumption"
  ],
  "optionDimensions": [
    {
      "attributeCode": "color",
      "label": "Color",
      "values": [
        {
          "valueCode": "black",
          "label": "Black"
        }
      ]
    }
  ],
  "variants": [
    {
      "variantPlanKey": "v1",
      "titleSuffix": "Black / 64GB",
      "optionValues": [
        {
          "attributeCode": "color",
          "valueCode": "black"
        },
        {
          "attributeCode": "capacity",
          "valueCode": "64gb"
        }
      ],
      "merchandisingRationale": "short reason this variant is plausible"
    }
  ],
  "impossibleCombination": {
    "optionValues": [
      {
        "attributeCode": "color",
        "valueCode": "black"
      },
      {
        "attributeCode": "capacity",
        "valueCode": "128gb"
      }
    ],
    "reason": "short reason this combination should not exist for this Product"
  }
}
```

## Hard constraints

- `schemaVersion` must be exactly `product-eval-variant-plan.v1`.
- Use exactly two `optionDimensions`.
- Each `attributeCode` must be one of: `color`, `size`, `capacity`,
  `configuration`.
- The two dimensions must have distinct `attributeCode` values.
- Each dimension must contain 2 to 4 distinct values.
- `valueCode` must be lowercase ASCII using only `a-z`, `0-9`, and `_`.
- `label`, `titleSuffix`, `merchandisingRationale`, and `reason` must be
  product-specific human-readable text.
- Wording must describe evaluation-design plausibility only. Do not claim that
  the merchant, brand, manufacturer, store, or market actually sells, does not
  sell, produces, does not produce, reserves, restricts, or discontinues any
  generated or impossible combination.
- `assumptions`, `merchandisingRationale`, and `impossibleCombination.reason`
  must explicitly frame the data as synthetic evaluation coverage when they
  explain why a combination exists or does not exist.
- Do not use these phrases or close variants: "merchant offering",
  "not sold", "not available", "only produced", "reserved for",
  "does not produce", "manufacturer produces", "real-world availability".
- `impossibleCombination.reason` should start with
  "Synthetic evaluation constraint:" and explain that the combination is
  intentionally excluded from the generated matrix for testing exact structured
  filtering.
- Generate 2 or 3 variants, never 1 and never more than 3.
- Every variant must contain exactly one value for each option dimension.
- `variantPlanKey` must be `v1`, `v2`, or `v3`, unique within the response, and
  ordered the same as the `variants` array.
- The `impossibleCombination` must contain exactly one value for each option
  dimension and must not duplicate any generated variant's option tuple.
- Do not include prices, inventory, offers, SKUs, identifiers, URLs, source
  names, handles, provenance, or database fields.
- If the product context is insufficient to create a plausible plan, return a
  JSON object with the same top-level structure and include a precise
  product-specific assumption in `assumptions`; do not return empty arrays and
  do not claim success by omitting required fields.

## Product context

The user message contains one sanitized JSON object with descriptive fields for
one Product. Treat it as the only descriptive input. Because the context is
synthetic-evaluation input, never infer or assert real merchant availability.
