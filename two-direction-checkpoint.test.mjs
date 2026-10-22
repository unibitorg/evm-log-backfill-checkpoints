// AI-assisted engineering by BlockVectra. MIT-0: use, modify and redistribute freely.
// Independent executable acceptance example for VISIALIS/alter#164, not Alter code.
// Run: node --test two-direction-checkpoint.test.mjs (Node 22); no dependencies/RPC.
// Only models page coordination and checkpoint ordering for one frozen scan scope.
// Production must bind chain/wallet/filter/bounds and implement persist atomically:
// idempotent log upserts + checkpoint in the same durable transaction.
// Timers/transport cancellation, finality/reorgs, historical RPC availability,
// response validation and completeness of successful RPC results are NOT modeled.
import assert from 'node:assert/strict';
import test from 'node:test';

function commitPair(state, page, persist) {
  if (page.from !== state.nextBlock || page.to < page.from) {
    throw new RangeError('Page must start at the next contiguous uncommitted block');
  }
  // Both direction results must finish before publishing this page as covered.
  if (!page.out.ok || !page.in.ok) return state;
  const rows = new Map();
  for (const log of [...page.out.logs, ...page.in.logs]) {
    const key = [log.blockHash, log.transactionHash, log.logIndex].join(':');
    if (rows.has(key) && JSON.stringify(rows.get(key)) !== JSON.stringify(log)) {
      throw new Error('Conflicting duplicate; keep the page uncommitted');
    }
    rows.set(key, log);
  }
  const next = { nextBlock: page.to + 1n };
  persist({ rows: [...rows.values()], nextBlock: next.nextBlock });
  return next; // The caller only replaces state after successful persistence.
}

const row = (n) => ({
  blockHash: 'fixture-block-' + n,
  transactionHash: 'fixture-tx-' + n,
  logIndex: '0x0',
});
const ok = (logs = []) => ({ ok: true, logs });
const failed = { ok: false };
const page = (from, to, out = ok(), incoming = ok()) => ({
  from, to, out, in: incoming,
});

test('one direction fails: no rows/checkpoint commit; retry starts at page start', () => {
  const state = { nextBlock: 10n };
  let writes = 0;
  const result = commitPair(state, page(10n, 19n, ok([row(10)]), failed), () => writes++);
  assert.strictEqual(result, state);
  assert.equal(result.nextBlock, 10n);
  assert.equal(writes, 0);
});

test('a later failed pair resumes after only the earlier fully committed page', () => {
  let state = { nextBlock: 10n };
  const committed = [];
  const persist = (batch) => committed.push(batch);
  state = commitPair(state, page(10n, 19n, ok([row(10)])), persist);
  state = commitPair(state, page(20n, 29n, ok([row(20)]), failed), persist);
  assert.equal(state.nextBlock, 20n);
  assert.equal(committed.length, 1);
  state = commitPair(state, page(20n, 29n, ok([row(20)]), ok([row(21)])), persist);
  assert.equal(state.nextBlock, 30n);
  assert.deepEqual(committed.map((b) => b.rows.length), [1, 2]);
});

test('a self-transfer returned by both directions is staged exactly once', () => {
  const self = row(42);
  let saved;
  const state = commitPair({ nextBlock: 42n }, page(42n, 42n, ok([self]), ok([{ ...self }])), (b) => { saved = b; });
  assert.equal(saved.rows.length, 1);
  assert.equal(state.nextBlock, 43n);
});

test('two successful empty directions still advance a covered page', () => {
  let saved;
  const state = commitPair({ nextBlock: 5n }, page(5n, 9n), (b) => { saved = b; });
  assert.deepEqual(saved.rows, []);
  assert.equal(saved.nextBlock, 10n);
  assert.equal(state.nextBlock, 10n);
});

test('persistence failure does not update the caller checkpoint', () => {
  let state = { nextBlock: 10n };
  assert.throws(() => {
    state = commitPair(state, page(10n, 19n), () => { throw new Error('fixture storage failure'); });
  }, /fixture storage failure/);
  assert.equal(state.nextBlock, 10n);
});

test('a later finished parallel page cannot jump over an uncommitted gap', () => {
  let writes = 0;
  assert.throws(() => commitPair({ nextBlock: 10n }, page(20n, 29n), () => writes++), RangeError);
  assert.equal(writes, 0);
});
