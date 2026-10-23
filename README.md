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
---

# EVM Log Backfill Checkpoint Cases

Six synthetic checkpoint cases and one separate timestamp-start counterexample for event backfills. Published by BlockVectra. These are evaluation/teaching examples, not production wallet histories, on-chain traces, or an independently validated benchmark.

The checkpoint data exports the six cases from our existing independent, dependency-free acceptance example. It is not VISIALIS/alter code or a claim that that project adopted a fix. This is the same six-case source in a machine-readable format, not six additional tests.

## What is included

`cases.jsonl` has six rows with a task prompt, structured input, expected checkpoint/persistence facts, and source provenance. Decimal block numbers are strings to avoid integer precision loss. The examples cover one failed direction, retry after an earlier committed page, self-transfer deduplication, trusted empty results in the toy model, persistence failure, and a parallel-page gap.

`two-direction-checkpoint.test.mjs` is the unchanged original executable source. With Node.js 22, run:

```sh
node --test two-direction-checkpoint.test.mjs
```

`input.pages[].persistence_throws` controls the constructed storage failure. The expected error is `RangeError` for a gap or `fixture storage failure` for that storage failure. `persist_attempts` includes the throwing call; `successful_persist_calls` does not. `persisted_row_counts` counts only completed calls. All cases use one frozen scan scope; they do not combine chains, accounts, filters, or bounds.

## Timestamp-start counterexample

This repository holds six original checkpoint cases (`cases.jsonl`, the `default` config) and one separate timestamp-start counterexample (`timestamp-start-cases.jsonl`, the `timestamp_start` config). The two files use separate schemas and dataset configurations.

The timestamp-start row is a single synthetic example. The chain has a monotonic block time: `T(n)=24*n` seconds for `0<=n<=6000`, then `T(n)=144000+12*(n-6000)` for `6000<n<=10000`. With head 10000 (T=192000), nominal block time 12 s, step block 4000 (T=96000) and a 120 s lookback, the target is 95880. An estimator that takes one sample block, averages block time over the sample-to-head span, and projects back returns block 4662. The first block with `T(n)>=95880` is 3995, so a forward scan from 4662 skips the event at block 4000. The estimator costs two block reads, counting the head. This shows that one sampled-average estimator can fail on one constructed chain. It is not a correct production algorithm or a fix.

Its motivation is the algorithm reviewed at [evm_arrivals.go](https://github.com/Munyon-Canyon/monaco/blob/f92222599f2945c0662e9263d57756f658015f59/apps/backend/internal/modules/trading/adapters/evm_arrivals.go#L284-L302) and [this review comment](https://github.com/Munyon-Canyon/monaco/pull/5462#issuecomment-6359666637). These links explain where the question came from; they do not say upstream adopted the case or that it reproduces on a real chain. The six original cases keep their own source below.

Run both test files with Node.js 22:

```sh
node --test two-direction-checkpoint.test.mjs timestamp-start.test.mjs
```

`timestamp-start.test.mjs` reads the JSONL, enumerates every block time to find the first block at or after the target, checks the times strictly increase, recomputes the estimator with BigInt integer arithmetic, and compares every stored expected value.

## Source and license

Original immutable source (for the six checkpoint cases only): [two-direction-checkpoint.test.mjs](https://gist.githubusercontent.com/gjwang/5a07d888ff5e89e1c99db2564b8c8d7a/raw/51f302e85ea2db406a0ccbfc3977af639ca88e45/two-direction-checkpoint.test.mjs).

Source SHA256: `a6756859142eca8a9406ea4d8fdf20b4d4bd46b42de52193a6a9bd0b7d0b709a`.

MIT license for this dataset and accompanying material; the unchanged source additionally carries its original MIT-0 permission notice. See `LICENSE`. BlockVectra created these constructed examples; no third-party issue text, real wallet addresses, credentials, or private telemetry are included.

## Limits and intended use

Use these as tiny evaluation fixtures or examples for agent-generated indexer code. In particular, the empty-result case assumes trusted successful results within this simplified model. It does **not** establish that a real provider's empty `eth_getLogs` response proves coverage. Historical availability, malformed/partial responses, transport cancellation, finality/reorgs, and real atomic database transactions are outside this model. A production indexer must bind the exact scan scope and enforce its own response, coverage, durability, and recovery rules.

There is no train/test independence claim, model score, live RPC test, real client adoption, or proof of model-training ingestion. Publishing the dataset makes the material available; it does not prove search indexing or training use. Do not use these six examples alone to certify a production indexer.

Further context: [BlockVectra log-range documentation](https://docs.blockvectra.com/en/guides/getlogs-block-range/?ref=github-backfill-cases). This link is documentation, not a claim that the service was exercised by this dataset.
