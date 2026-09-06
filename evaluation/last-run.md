# Quality Evaluation Report

Run date: 2026-09-06T05:13:56.990Z
Dataset: 43 documents, 15 labeled
Providers: OCR — `mock`, LLM — `mock`
Schema version: 1 (seed), rules: 13

## Metrics (spec §12)

| Metric | Value | Target |
| --- | --- | --- |
| Classification accuracy | 97.6% | ≥ 95% |
| Critical field exact match | 100% | ≥ 90% |
| Field coverage | 100% | ≥ 98% |
| Source coverage | 100% | reported as-is |
| Straight-through rate | 95.2% | reported as-is |
| False auto-approval | 0 | 0 on the labeled dataset |
| Median review time | not measured here | requires operator telemetry |

## Negative scenarios

- Corrupted files: rejected 1 of 1
- Multiple documents in one file: 1 warning(s)

## How to read this report

This run used **mock providers**. The mock LLM knows the demo label format, so high extraction scores validate the evidence matcher, normalization, validation, and routing pipeline, NOT language-model quality. Measure the model with `LLM_PROVIDER=openai_compatible` and real credentials.

## Documents

| File | Type | Outcome | Critical fields |
| --- | --- | --- | --- |
| invoice-001.pdf | invoice | automatic | matched |
| invoice-002.pdf | invoice | automatic | matched |
| invoice-003.pdf | invoice | automatic | matched |
| invoice-004.pdf | invoice | automatic | matched |
| invoice-005.pdf | invoice | automatic | matched |
| invoice-006.pdf | invoice | automatic | matched |
| invoice-007.pdf | invoice | automatic | matched |
| invoice-008.pdf | invoice | automatic | matched |
| invoice-009.pdf | invoice | automatic | matched |
| invoice-010.pdf | invoice | automatic | matched |
| invoice-011.pdf | invoice | automatic | matched |
| invoice-012.pdf | invoice | automatic | matched |
| bank_statement-001.pdf | bank_statement | automatic | matched |
| bank_statement-002.pdf | bank_statement | automatic | matched |
| bank_statement-003.pdf | bank_statement | automatic | matched |
| bank_statement-004.pdf | bank_statement | automatic | matched |
| bank_statement-005.pdf | bank_statement | automatic | matched |
| bank_statement-006.pdf | bank_statement | automatic | matched |
| bank_statement-007.pdf | bank_statement | automatic | matched |
| bank_statement-008.pdf | bank_statement | automatic | matched |
| bank_statement-009.pdf | bank_statement | automatic | matched |
| tax_letter-001.pdf | tax_letter | automatic | matched |
| tax_letter-002.pdf | tax_letter | automatic | matched |
| tax_letter-003.pdf | tax_letter | automatic | matched |
| tax_letter-004.pdf | tax_letter | automatic | matched |
| tax_letter-005.pdf | tax_letter | automatic | matched |
| tax_letter-006.pdf | tax_letter | automatic | matched |
| tax_letter-007.pdf | tax_letter | automatic | matched |
| tax_letter-008.pdf | tax_letter | automatic | matched |
| tax_letter-009.pdf | tax_letter | automatic | matched |
| contract-001.pdf | contract | automatic | matched |
| contract-002.pdf | contract | automatic | matched |
| contract-003.pdf | contract | automatic | matched |
| contract-004.pdf | contract | automatic | matched |
| contract-005.pdf | contract | automatic | matched |
| contract-006.pdf | contract | automatic | matched |
| contract-007.pdf | contract | automatic | matched |
| contract-008.pdf | contract | automatic | matched |
| contract-009.pdf | contract | automatic | matched |
| scan-low-quality.jpg | unknown | review | — |
| duplicate-invoice.pdf | invoice | automatic | matched |
| corrupted.pdf | — | rejected | — |
| multi-document.pdf | invoice | review | matched |
