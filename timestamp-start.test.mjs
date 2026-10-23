// Dependency-free check of one synthetic counterexample (Node 22): run
// node --test timestamp-start.test.mjs
// It re-derives every stored expected value and builds the oracle by plain enumeration.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const NS = 1_000_000_000n;
const ceilDiv = (a, b) => (a + b - 1n) / b;
const max0 = (v) => (v < 0n ? 0n : v);

function timeAt(n) {
  if (n >= 0n && n <= 6000n) return 24n * n;
  if (n > 6000n && n <= 10000n) return 144000n + 12n * (n - 6000n);
  throw new RangeError('block outside the synthetic chain');
}

test('sampled-average estimator starts after the first block at or after the target', () => {
  const lines = readFileSync(new URL('./timestamp-start-cases.jsonl', import.meta.url), 'utf8')
    .split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  const { input, expected } = row;
  assert.equal(row.synthetic, true);
  assert.equal(row.language, 'en');
  assert.equal(row.license, 'MIT');

  const head = BigInt(input.block_time_seconds.head_block);
  const headT = BigInt(input.block_time_seconds.head_timestamp);
  const nominal = BigInt(input.block_time_seconds.nominal_block_time_seconds);
  const step = BigInt(input.block_time_seconds.step_block);
  const stepT = BigInt(input.block_time_seconds.step_timestamp);
  const lookback = BigInt(input.block_time_seconds.lookback_seconds);
  const target = BigInt(input.block_time_seconds.target_timestamp);
  const event = BigInt(input.event_block);

  // Fixture parameters agree with the formula.
  assert.equal(timeAt(head), headT);
  assert.equal(timeAt(step), stepT);
  assert.equal(stepT - lookback, target);

  // Oracle: enumerate every block, require strictly increasing time, take the first T(n) >= target.
  const times = [];
  for (let n = 0n; n <= head; n++) times.push(timeAt(n));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1]);
  const oracle = BigInt(times.findIndex((t) => t >= target));
  assert.ok(times[Number(oracle)] >= target);
  assert.ok(oracle === 0n || times[Number(oracle) - 1] < target);

  // Estimator under review.
  const ago = headT - target;
  const guess = max0(head - ceilDiv(ago, nominal));
  const sampleT = timeAt(guess);
  const span = head - guess;
  const elapsed = headT - sampleT;
  const averageNs = (elapsed * NS) / span;
  const returned = max0(head - ceilDiv(ago * NS, averageNs));
  const blockReads = 1 + 1; // head (already read) + one sample

  assert.equal(guess.toString(), expected.sample_block);
  assert.equal(sampleT.toString(), expected.sample_timestamp);
  assert.equal(ago.toString(), expected.ago);
  assert.equal(span.toString(), expected.span);
  assert.equal(elapsed.toString(), expected.elapsed);
  assert.equal(returned.toString(), expected.returned_start);
  assert.equal(oracle.toString(), expected.oracle_first_block_at_or_after_target);
  assert.equal(blockReads, 2);
  assert.equal(String(blockReads), expected.two_block_reads);

  // The step block is skipped by a forward scan from the returned start.
  const stepExcluded = step < returned;
  assert.equal(stepExcluded, expected.step_excluded);
  assert.ok(oracle <= event && event < returned);
  assert.ok(oracle < returned);
});
