# Performance evaluation

Run: 2026-09-07T04:15:04.985Z
Environment: {"description":"Native API and worker; production Next web; PostgreSQL 18, Redis 7 and MinIO in Colima VM (2 CPU, 4 GiB); localhost; one worker process; concurrency verified in worker startup log: default 4, OCR 2, extraction 2.","node":"v24.14.1","os":"darwin 25.6.0","cpu":"Apple M1","logicalCpus":8,"memoryGiB":16}.
Providers: {"ocr":"mock","llm":"mock","model":null}. API configuration: {"default":4,"ocr":2,"extraction":2}; the worker must use the same environment.

**Mock providers measure local pipeline overhead, not external-provider latency.**

46 documents existed before this run. Repeated corpus uploads exercise normal duplicate/uniqueness checks; decisions may require review. No data is reset by this script.

## Upload to decision

Three sequential uploads per size. The ten-page fixture has one invoice page and nine nonblank text attachments, not ten dense/scanned invoice pages. Durations include upload and polling (100 ms interval); all individual outcomes are in JSON.

| Pages | Samples | Median ms | Max ms |
| --- | --- | --- | --- |
| 1 | 3 | 141 | 148 |
| 10 | 3 | 136 | 136 |

## 20 simultaneous uploads

Submitted 20; total completion 817 ms; per-document median 705 ms. Failures across sequential and load cases: 0.

Peak sampled queue counts: {"preprocess":{"active":4,"wait":16,"delayed":0,"failed":0},"ocr":{"active":2,"wait":10,"delayed":0,"failed":0},"classify":{"active":3,"wait":1,"delayed":0,"failed":0},"extract":{"active":2,"wait":7,"delayed":0,"failed":0},"validate":{"active":3,"wait":0,"delayed":0,"failed":0}}.
Final queue counts: {"preprocess":{"active":0,"wait":0,"delayed":0,"failed":0},"ocr":{"active":0,"wait":0,"delayed":0,"failed":0},"classify":{"active":0,"wait":0,"delayed":0,"failed":0},"extract":{"active":0,"wait":0,"delayed":0,"failed":0},"validate":{"active":0,"wait":0,"delayed":0,"failed":0}}.
Queue counts are read directly from BullMQ every 100 ms plus Redis response time; short peaks may be missed. Sampling overhead is included.

## First page and fields

Fresh browser context per full navigation; empty HTTP cache; warm API/worker/web processes and shared server caches; no CPU/network throttling. Mark recorded after hydration and first-page image load with fields rendered.
Chrome 145.0.7632.116; 1440x900; 6 samples; median 146.5 ms, max 231 ms.

## Review time

Manual approvals: 0; measured: 0; median: not measured ms. Browser openings verify instrumentation; this unattended benchmark does not simulate human review. The PostgreSQL/API regression test verifies timestamp pairing and median calculation.

Real-provider latency and human review time remain deferred. These small localhost samples do not establish production p95 or capacity.
