# Quality Evaluation Report

Run: 2026-09-07T04:10:41.945Z
Dataset v2: 46 synthetic documents; 15 labeled across all four types and negative cases.
Manifest SHA-256: `d1f94e3cee7e5550e1b488962235a1d882cf556b0a2b201206b4f9d4fbd7b6bf`
OCR: `mock`; LLM: `mock`; model: `deterministic mock`.
Validation date: 2026-09-07. Rules and thresholds are those stored in each schema version.

The run uploads files through the real authenticated API and waits for production workers, PostgreSQL, Redis and object storage. No validation/confidence/routing code is reimplemented in the evaluator.

**Mock run: pipeline evidence only. Real-provider quality remains unverified.**

## Schema and rule versions

- invoice: version 1, ID `01a07a0d-1308-72b7-908d-f78c820bbc60`, 7 rules; thresholds {"autoClassify":0.7,"criticalFieldConfidence":0.8,"fieldConfidence":0.6}.
- bank_statement: version 1, ID `01a07a0d-130f-7d89-ab98-92f573ba7f33`, 2 rules; thresholds {"autoClassify":0.7,"criticalFieldConfidence":0.8,"fieldConfidence":0.6}.
- tax_letter: version 1, ID `01a07a0d-1314-7f21-b147-6aef567e91fd`, 2 rules; thresholds {"autoClassify":0.7,"criticalFieldConfidence":0.8,"fieldConfidence":0.6}.
- contract: version 1, ID `01a07a0d-131a-7a6b-8371-abe489e3a6a7`, 2 rules; thresholds {"autoClassify":0.7,"criticalFieldConfidence":0.8,"fieldConfidence":0.6}.

## Labeled set (15 documents)

| Metric | Numerator / denominator | Value | Target | Result |
| --- | --- | --- | --- | --- |
| Classification accuracy | 14 / 14 | 100% | ≥95% | met |
| Critical field exact match | 72 / 72 | 100% | ≥90% | met |
| Field coverage (including correct Missing) | 117 / 117 | 100% | ≥98% | met |
| Source coverage | 116 / 116 | 100% | reported | — |
| Straight-through rate | 8 / 15 | 53.3% | reported | — |
| False auto-approval | 0 / 8 auto-approved | 0 | 0 | met |

Valid documents rejected: 0; failed/timeouts: 0; Unknown: 0. Invalid files rejected: 1/1. Multi-document warnings detected: 1/1.

## Full corpus

| Metric | Numerator / denominator | Value | Target | Result |
| --- | --- | --- | --- | --- |
| Classification accuracy | 44 / 45 | 97.8% | ≥95% | met |
| Critical field exact match | 228 / 234 | 97.4% | ≥90% | met |
| Field coverage (including correct Missing) | 369 / 378 | 97.6% | ≥98% | NOT MET |
| Source coverage | 367 / 367 | 100% | reported | — |
| Straight-through rate | 31 / 46 | 67.4% | reported | — |
| False auto-approval | 0 / 31 auto-approved | 0 | 0 | met |

Valid documents rejected: 0; failed/timeouts: 0; Unknown: 1. Invalid files rejected: 1/1. Multi-document warnings detected: 1/1.

## Definitions and limitations

- Classification and critical/field denominators come from the expected valid documents, including rejected, failed and Unknown results. A zero denominator is N/A and cannot satisfy a target.
- Field coverage requires an actual field with a value when the source contains one, or an explicit null when ground truth says Missing. It does not measure value accuracy. Critical exact match compares normalized values (numeric tolerance below half a cent).
- False auto-approval means Approved despite a prohibited automatic decision, wrong type, missing/wrong annotated value, or blocking issues. This includes corrupted, multi-document, required-Missing and invalid-sum cases, not just critical-value mismatches.
- Straight-through rate uses all submitted documents. Source coverage uses all returned non-null values.
- Ground truth comes from generator inputs, including optional Missing; it is not copied from OCR/LLM predictions. The synthetic corpus does not establish production document diversity.
- Median human review time: not measured ms; measured 0/0 manual approvals. This unattended run performs no human reviews.
- Processing latency, 20-document load and browser first-page/fields display are measured separately in performance reports. Polling adds up to 100 ms plus request time to observed completion.

## Documents

| File | Type | Outcome | Values match | Schema version | False auto |
| --- | --- | --- | --- | --- | --- |
| invoice-001.pdf | invoice | approved | true | 1 | false |
| invoice-002.pdf | invoice | approved | true | 1 | false |
| invoice-003.pdf | invoice | approved | true | 1 | false |
| invoice-004.pdf | invoice | approved | true | 1 | false |
| invoice-005.pdf | invoice | approved | true | 1 | false |
| invoice-006.pdf | invoice | approved | true | 1 | false |
| invoice-007.pdf | invoice | approved | true | 1 | false |
| invoice-008.pdf | invoice | approved | true | 1 | false |
| invoice-009.pdf | invoice | approved | true | 1 | false |
| invoice-010.pdf | invoice | approved | true | 1 | false |
| invoice-011.pdf | invoice | approved | true | 1 | false |
| invoice-012.pdf | invoice | approved | true | 1 | false |
| bank_statement-001.pdf | bank_statement | approved | true | 1 | false |
| bank_statement-002.pdf | bank_statement | approved | true | 1 | false |
| bank_statement-003.pdf | bank_statement | approved | true | 1 | false |
| bank_statement-004.pdf | bank_statement | approved | true | 1 | false |
| bank_statement-005.pdf | bank_statement | approved | true | 1 | false |
| bank_statement-006.pdf | bank_statement | approved | true | 1 | false |
| bank_statement-007.pdf | bank_statement | approved | true | 1 | false |
| bank_statement-008.pdf | bank_statement | approved | true | 1 | false |
| bank_statement-009.pdf | bank_statement | approved | true | 1 | false |
| tax_letter-001.pdf | tax_letter | needs_review | false | 1 | false |
| tax_letter-002.pdf | tax_letter | needs_review | false | 1 | false |
| tax_letter-003.pdf | tax_letter | needs_review | false | 1 | false |
| tax_letter-004.pdf | tax_letter | needs_review | false | 1 | false |
| tax_letter-005.pdf | tax_letter | needs_review | false | 1 | false |
| tax_letter-006.pdf | tax_letter | needs_review | false | 1 | false |
| tax_letter-007.pdf | tax_letter | needs_review | false | 1 | false |
| tax_letter-008.pdf | tax_letter | needs_review | false | 1 | false |
| tax_letter-009.pdf | tax_letter | needs_review | false | 1 | false |
| contract-001.pdf | contract | approved | true | 1 | false |
| contract-002.pdf | contract | approved | true | 1 | false |
| contract-003.pdf | contract | approved | true | 1 | false |
| contract-004.pdf | contract | approved | true | 1 | false |
| contract-005.pdf | contract | approved | true | 1 | false |
| contract-006.pdf | contract | approved | true | 1 | false |
| contract-007.pdf | contract | approved | true | 1 | false |
| contract-008.pdf | contract | approved | true | 1 | false |
| contract-009.pdf | contract | approved | true | 1 | false |
| scan-low-quality.jpg | unknown | needs_review | false | — | false |
| duplicate-invoice.pdf | invoice | needs_review | true | 1 | false |
| corrupted.pdf | — | rejected | false | — | false |
| multi-document.pdf | invoice | needs_review | false | 1 | false |
| missing-critical.pdf | invoice | needs_review | true | 1 | false |
| sum-mismatch.pdf | invoice | needs_review | true | 1 | false |
| optional-missing.pdf | invoice | approved | true | 1 | false |
