# Performance evaluation

Run: 2026-09-07T05:34:15.351Z
Environment: {"description":"isolated phase7 mock stack; PDF.js; native M1; disposable PostgreSQL/Redis/MinIO","node":"v24.14.1","os":"darwin 25.6.0","cpu":"Apple M1","logicalCpus":8,"memoryGiB":16}.
Providers: {"ocr":"mock","llm":"mock","model":null}. API configuration: {"default":4,"ocr":4,"extraction":4}; the worker must use the same environment.

**Mock providers measure local pipeline overhead, not external-provider latency.**

46 documents existed before this run. Repeated corpus uploads exercise normal duplicate/uniqueness checks; decisions may require review. No data is reset by this script.

## Upload to decision

Three sequential uploads per size. The ten-page fixture has one invoice page and nine nonblank text attachments, not ten dense/scanned invoice pages. Durations include upload and polling (100 ms interval); all individual outcomes are in JSON.

| Pages | Samples | Median ms | Max ms |
| --- | --- | --- | --- |
| 1 | 3 | 133 | 143 |
| 10 | 3 | 143 | 244 |

## 20 simultaneous uploads

Submitted 20; total completion 1166 ms; per-document median 1027.5 ms. Failures across sequential and load cases: 0.

Peak sampled queue counts: {"preprocess":{"active":4,"wait":16,"delayed":0,"failed":0},"ocr":{"active":4,"wait":1,"delayed":0,"failed":0},"classify":{"active":4,"wait":1,"delayed":0,"failed":0},"extract":{"active":4,"wait":2,"delayed":0,"failed":0},"validate":{"active":4,"wait":1,"delayed":0,"failed":0}}.
Final queue counts: {"preprocess":{"active":0,"wait":0,"delayed":0,"failed":0},"ocr":{"active":0,"wait":0,"delayed":0,"failed":0},"classify":{"active":0,"wait":0,"delayed":0,"failed":0},"extract":{"active":0,"wait":0,"delayed":0,"failed":0},"validate":{"active":0,"wait":0,"delayed":0,"failed":0}}.
Queue counts are read directly from BullMQ every 100 ms plus Redis response time; short peaks may be missed. Sampling overhead is included.

## First page and fields

Fresh browser context per full navigation; empty HTTP cache; warm API/worker/web processes and shared server caches; no CPU/network throttling. Mark recorded after hydration and first-page image load with fields rendered.
Chrome 145.0.7632.116; 1440x900; 6 samples; median 233 ms, max 359 ms.

## Review time

Manual approvals: 0; measured: 0; median: not measured ms. Browser openings verify instrumentation; this unattended benchmark does not simulate human review. The PostgreSQL/API regression test verifies timestamp pairing and median calculation.

Real-provider latency and human review time remain deferred. These small localhost samples do not establish production p95 or capacity.
