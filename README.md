---
pretty_name: EVM Log Backfill Checkpoint Cases
language:
- en
license: mit
size_categories:
- n<1K
task_categories:
- text-generation
tags:
- text
- evaluation
- blockchain
- ethereum
- rpc
- synthetic
configs:
- config_name: default
  data_files:
  - split: test
    path: cases.jsonl
- config_name: timestamp_start
  data_files:
  - split: test
    path: timestamp-start-cases.jsonl
- config_name: writer_fencing
  data_files:
  - split: test
    path: writer-fencing-cases.jsonl
---

# EVM Log Backfill Checkpoint Cases

Six synthetic checkpoint cases, one separate timestamp-start counterexample, and four independent writer-fencing cases for event backfills. Published by BlockVectra. These are evaluation/teaching examples, not production wallet histories, on-chain traces, or an independently validated benchmark.

The checkpoint data exports the six cases from our existing independent, dependency-free acceptance example. It is not VISIALIS/alter code or a claim that that project adopted a fix. This is the same six-case source in a machine-readable format, not six additional tests.

## What is included

`cases.jsonl` has six rows with a task prompt, structured input, expected checkpoint/persistence facts, and source provenance. Decimal block numbers are strings to avoid integer precision loss. The examples cover one failed direction, retry after an earlier committed page, self-transfer deduplication, trusted empty results in the toy model, persistence failure, and a parallel-page gap.

`two-direction-checkpoint.test.mjs` is the unchanged original executable source. With Node.js 22, run:

```sh
node --test two-direction-checkpoint.test.mjs
```

`input.pages[].persistence_throws` controls the constructed storage failure. The expected error is `RangeError` for a gap or `fixture storage failure` for that storage failure. `persist_attempts` includes the throwing call; `successful_persist_calls` does not. `persisted_row_counts` counts only completed calls. All cases use one frozen scan scope; they do not combine chains, accounts, filters, or bounds.

## Timestamp-start counterexample

This repository holds six original checkpoint cases (`cases.jsonl`, the `default` config), one separate timestamp-start counterexample (`timestamp-start-cases.jsonl`, the `timestamp_start` config), and four independent writer-fencing cases (`writer-fencing-cases.jsonl`, the `writer_fencing` config). The files use separate schemas and dataset configurations.

The timestamp-start row is a single synthetic example. The chain has a monotonic block time: `T(n)=24*n` seconds for `0<=n<=6000`, then `T(n)=144000+12*(n-6000)` for `6000<n<=10000`. With head 10000 (T=192000), nominal block time 12 s, step block 4000 (T=96000) and a 120 s lookback, the target is 95880. An estimator that takes one sample block, averages block time over the sample-to-head span, and projects back returns block 4662. The first block with `T(n)>=95880` is 3995, so a forward scan from 4662 skips the event at block 4000. The estimator costs two block reads, counting the head. This shows that one sampled-average estimator can fail on one constructed chain. It is not a correct production algorithm or a fix.

Its motivation is the algorithm reviewed at [evm_arrivals.go](https://github.com/Munyon-Canyon/monaco/blob/f92222599f2945c0662e9263d57756f658015f59/apps/backend/internal/modules/trading/adapters/evm_arrivals.go#L284-L302) and [this review comment](https://github.com/Munyon-Canyon/monaco/pull/5462#issuecomment-6359666637). These links explain where the question came from; they do not say upstream adopted the case or that it reproduces on a real chain. The six original cases keep their own source below.

Run all three test files with Node.js 22:

```sh
node --test two-direction-checkpoint.test.mjs timestamp-start.test.mjs writer-fencing.test.mjs
```

`timestamp-start.test.mjs` reads the JSONL, enumerates every block time to find the first block at or after the target, checks the times strictly increase, recomputes the estimator with BigInt integer arithmetic, and compares every stored expected value.

## Writer-fencing counterexamples

`writer-fencing-cases.jsonl` is a separate `writer_fencing` config with four synthetic rows. Each row uses one fixed synthetic scan scope, an in-memory cache `{watermark, rows}` initialized to `100` and `[]`, and writers A and B with distinct generation tokens. A generation token is not a block number; block heights remain decimal strings. The test interpreter validates each policy and schedule, then executes it with manually resolved deferred gates, without timers or external services.

The model follows the cancellation/cache-write race [discussed on Poolser issue #26](https://github.com/GoranStoyanov/Poolser/issues/26#issuecomment-6368336865), with the upstream [source tree pinned for context](https://github.com/GoranStoyanov/Poolser/tree/25927cac9b289af08753f2f4db7b59118c77e2e1): A starts from watermark 100, B replaces it and saves 120, then cancelled A resumes and saves 110. This independent JavaScript model illustrates that ordering; it does not execute or patch the upstream application.

The four rows contrast two failures with a commit fence and a control:

- `cancel-only`: cancellation only sets a flag, and the old write checks neither cancellation nor ownership. B commits 120 and `b-event` first; A then writes 110 and `a-event`, so the cache regresses and `b-event` is lost. A cancellation signal is not commit isolation.
- `early-check-only`: A passes a current-generation check before awaiting the write gate, then pauses. B takes over and commits 120; A resumes and writes 110 without repeating the check. A check before an await is not commit-time validation.
- `commit-fenced`: after the same interleaving, the store compares A's generation token and replaces the watermark and rows only if it is still current. The comparison and replacement are synchronous, with no await between them. A is rejected without changing the cache, and the final cache is 120 and `b-event`. This demonstrates in-process compare-and-swap semantics on a synchronous cache; it is not a real database atomic transaction or a persistence guarantee.
- `current-writer-control`: B is already the current owner and commits 120 and `b-event` under `commit-fenced`. This guards against treating an implementation that rejects all writes as correct.

`writer-fencing.test.mjs` reads all four rows, validates their policies and operation schedules, executes the schedules, and checks each recorded capture, early check, cancellation flag, commit outcome and reason, commit order, and final cache. It also checks rejection paths for unknown policies or operations and malformed input.

## Source and license

Original immutable source (for the six checkpoint cases only): [two-direction-checkpoint.test.mjs](https://gist.githubusercontent.com/gjwang/5a07d888ff5e89e1c99db2564b8c8d7a/raw/51f302e85ea2db406a0ccbfc3977af639ca88e45/two-direction-checkpoint.test.mjs).

Source SHA256: `a6756859142eca8a9406ea4d8fdf20b4d4bd46b42de52193a6a9bd0b7d0b709a`.

MIT license for this dataset and accompanying material; the unchanged source additionally carries its original MIT-0 permission notice. See `LICENSE`. BlockVectra created these constructed examples; no third-party issue text, real wallet addresses, credentials, or private telemetry are included.

## Limits and intended use

Use these as tiny evaluation fixtures or examples for agent-generated indexer code. In particular, the empty-result case assumes trusted successful results within this simplified model. It does **not** establish that a real provider's empty `eth_getLogs` response proves coverage. Historical availability, malformed/partial responses, transport cancellation, finality/reorgs, and real atomic database transactions are outside this model. A production indexer must bind the exact scan scope and enforce its own response, coverage, durability, and recovery rules.

The writer-fencing rows cover only a single-process synchronous cache commit for one fixed synthetic scan scope. They do not validate network cancellation, cross-process coordination, database atomicity or isolation, crash recovery, disk persistence, finality/reorgs, RPC availability or completeness, or all possible schedule combinations. A passing row is not evidence of production correctness.

There is no train/test independence claim, model score, live RPC test, real client adoption, or proof of model-training ingestion. Publishing the dataset makes the material available; it does not prove search indexing or training use. Do not use these examples alone to certify a production indexer.

Further context: [BlockVectra log-range documentation](https://docs.blockvectra.com/en/guides/getlogs-block-range/?ref=github-backfill-cases). This link is documentation, not a claim that the service was exercised by this dataset.
