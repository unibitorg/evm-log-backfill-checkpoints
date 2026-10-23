// Dependency-free check of four synthetic writer-fencing cases (Node 22): run
// node --test writer-fencing.test.mjs
// The schedules are executed with manually resolved deferred gates. There are
// no timers, network calls, RPC, database operations, real processes, or disk
// writes here. This is an in-process cache model, not a durability guarantee.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const POLICIES = new Set(['cancel-only', 'early-check-only', 'commit-fenced']);
const OPERATIONS = new Set([
  'capture',
  'prepare',
  'start-commit',
  'cancel',
  'takeover',
  'release-gate',
  'await-commit',
]);
const IDS = [
  'writer-fencing-cancel-only',
  'writer-fencing-early-check-only',
  'writer-fencing-commit-fenced',
  'writer-fencing-current-writer-control',
];

function cloneCache(cache) {
  return { watermark: cache.watermark, rows: [...cache.rows] };
}

function decimal(value, label) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new Error(`${label} must be a decimal string`);
  }
  return value;
}

function eventRows(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const unique = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`${label} IDs must be non-empty strings`);
    }
    if (unique.has(id)) throw new Error(`${label} has a duplicate event ID: ${id}`);
    unique.add(id);
  }
  return [...value];
}

function cacheShape(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return {
    watermark: decimal(value.watermark, `${label}.watermark`),
    rows: eventRows(value.rows, `${label}.rows`),
  };
}

function validateInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('input must be an object');
  }
  if (raw.scope !== 'synthetic-scan-scope-1') {
    throw new Error('input.scope is not the frozen synthetic scope');
  }
  if (!POLICIES.has(raw.policy)) {
    throw new Error(`unknown policy: ${String(raw.policy)}`);
  }
  const initialCache = cacheShape(raw.initial_cache, 'initial_cache');
  if (!raw.writers || typeof raw.writers !== 'object' || Array.isArray(raw.writers)) {
    throw new Error('writers must be an object');
  }
  const writerNames = Object.keys(raw.writers).sort();
  if (writerNames.join(',') !== 'A,B') {
    throw new Error('writers must contain exactly A and B');
  }
  const writers = {};
  const generations = new Set();
  for (const name of writerNames) {
    const spec = raw.writers[name];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`writers.${name} must be an object`);
    }
    if (typeof spec.generation !== 'string' || spec.generation.length === 0) {
      throw new Error(`writers.${name}.generation must be a non-empty string`);
    }
    if (DECIMAL.test(spec.generation)) {
      throw new Error(`writers.${name}.generation must be a token, not a block number`);
    }
    if (generations.has(spec.generation)) {
      throw new Error(`duplicate generation token: ${spec.generation}`);
    }
    generations.add(spec.generation);
    writers[name] = { generation: spec.generation };
  }
  if (!generations.has(raw.initial_generation)) {
    throw new Error('initial_generation must name one configured writer');
  }
  if (!Array.isArray(raw.schedule) || raw.schedule.length === 0) {
    throw new Error('schedule must be a non-empty array');
  }
  const schedule = raw.schedule.map((step, index) => {
    const label = `schedule[${index}]`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(`${label} must be an object`);
    }
    if (!OPERATIONS.has(step.op)) {
      throw new Error(`unknown operation: ${String(step.op)}`);
    }
    if (step.op === 'release-gate') {
      if (typeof step.gate !== 'string' || step.gate.length === 0) {
        throw new Error(`${label}.gate must be a non-empty string`);
      }
      return { op: step.op, gate: step.gate };
    }
    if (!Object.hasOwn(writers, step.writer)) {
      throw new Error(`${label}.writer must be A or B`);
    }
    if (step.op === 'prepare') {
      return {
        op: step.op,
        writer: step.writer,
        watermark: decimal(step.watermark, `${label}.watermark`),
        rows: eventRows(step.rows, `${label}.rows`),
      };
    }
    if (step.op === 'start-commit' && step.gate !== undefined) {
      if (typeof step.gate !== 'string' || step.gate.length === 0) {
        throw new Error(`${label}.gate must be a non-empty string`);
      }
      return { op: step.op, writer: step.writer, gate: step.gate };
    }
    return { op: step.op, writer: step.writer };
  });
  return {
    policy: raw.policy,
    initialCache,
    initialGeneration: raw.initial_generation,
    writers,
    schedule,
  };
}

class CacheStore {
  constructor(cache, generation) {
    this.cache = cloneCache(cache);
    this.generation = generation;
  }

  snapshot() {
    return cloneCache(this.cache);
  }

  isCurrent(generation) {
    return this.generation === generation;
  }

  takeOver(generation) {
    this.generation = generation;
  }

  replace(candidate) {
    this.cache = cloneCache(candidate);
  }

  commitFenced(generation, candidate) {
    // This method is intentionally synchronous: no await belongs between the
    // generation comparison and the cache replacement.
    const beforeWrite = this.snapshot();
    if (generation !== this.generation) {
      return {
        outcome: 'rejected',
        reason: 'commit-fenced rejected the write: stale generation at the synchronous fence',
        cache_before_write: beforeWrite,
      };
    }
    this.cache = cloneCache(candidate);
    return {
      outcome: 'committed',
      reason: 'commit-fenced accepted the write: generation matched at the synchronous fence',
      cache_before_write: beforeWrite,
    };
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve, released: false };
}

async function applyPolicy(policy, writer, gate, store, earlyChecks) {
  if (policy === 'early-check-only') {
    const passed = store.isCurrent(writer.generation);
    earlyChecks.push({
      writer: writer.name,
      passed,
      generation: writer.generation,
      current_generation: store.generation,
    });
    if (!passed) {
      return {
        outcome: 'rejected',
        reason: 'early-check-only rejected the write: stale generation at the early pre-await check',
        cache_before_write: store.snapshot(),
      };
    }
  }
  if (gate) await gate.promise;
  if (policy === 'cancel-only') {
    const beforeWrite = store.snapshot();
    store.replace(writer.prepared);
    return {
      outcome: 'committed',
      reason: 'cancel-only applied the write without checking cancellation or the current owner',
      cache_before_write: beforeWrite,
    };
  }
  if (policy === 'early-check-only') {
    const beforeWrite = store.snapshot();
    store.replace(writer.prepared);
    return {
      outcome: 'committed',
      reason: 'early-check-only applied the write after the pre-await check without checking again at commit',
      cache_before_write: beforeWrite,
    };
  }
  if (policy === 'commit-fenced') {
    return store.commitFenced(writer.generation, writer.prepared);
  }
  throw new Error(`unknown policy: ${policy}`);
}

async function execute(input) {
  const store = new CacheStore(input.initialCache, input.initialGeneration);
  const gates = new Map();
  const captures = [];
  const cancelled = [];
  const earlyChecks = [];
  const attempts = [];
  const commitOrder = [];
  const writers = {};
  for (const [name, spec] of Object.entries(input.writers)) {
    writers[name] = {
      name,
      generation: spec.generation,
      snapshot: null,
      prepared: null,
      cancelled: false,
      task: null,
      awaited: false,
    };
  }

  const writerFor = (name) => {
    const writer = writers[name];
    if (!writer) throw new Error(`unknown writer: ${name}`);
    return writer;
  };

  for (const step of input.schedule) {
    if (step.op === 'capture') {
      const writer = writerFor(step.writer);
      if (writer.snapshot) throw new Error(`writer ${writer.name} captured twice`);
      writer.snapshot = store.snapshot();
      captures.push({ writer: writer.name, watermark: writer.snapshot.watermark });
      continue;
    }
    if (step.op === 'prepare') {
      const writer = writerFor(step.writer);
      if (!writer.snapshot) throw new Error(`writer ${writer.name} must capture before prepare`);
      if (writer.prepared) throw new Error(`writer ${writer.name} prepared twice`);
      if (BigInt(step.watermark) <= BigInt(writer.snapshot.watermark)) {
        throw new Error(`writer ${writer.name} candidate must advance its snapshot`);
      }
      writer.prepared = { watermark: step.watermark, rows: [...step.rows] };
      continue;
    }
    if (step.op === 'start-commit') {
      const writer = writerFor(step.writer);
      if (!writer.prepared) throw new Error(`writer ${writer.name} has nothing to commit`);
      if (writer.task) throw new Error(`writer ${writer.name} already started a commit`);
      let gate = null;
      if (step.gate) {
        if (gates.has(step.gate)) throw new Error(`duplicate gate: ${step.gate}`);
        gate = deferred();
        gates.set(step.gate, gate);
      }
      const attempt = {
        writer: writer.name,
        candidate: { watermark: writer.prepared.watermark, rows: [...writer.prepared.rows] },
        outcome: null,
        reason: null,
        cache_before_write: null,
        cache_after: null,
      };
      attempts.push(attempt);
      writer.task = (async () => {
        const result = await applyPolicy(input.policy, writer, gate, store, earlyChecks);
        attempt.outcome = result.outcome;
        attempt.reason = result.reason;
        attempt.cache_before_write = result.cache_before_write;
        attempt.cache_after = store.snapshot();
        commitOrder.push(writer.name);
      })();
      continue;
    }
    if (step.op === 'cancel') {
      const writer = writerFor(step.writer);
      if (writer.cancelled) throw new Error(`writer ${writer.name} cancelled twice`);
      writer.cancelled = true;
      cancelled.push(writer.name);
      continue;
    }
    if (step.op === 'takeover') {
      const writer = writerFor(step.writer);
      if (writer.cancelled) throw new Error(`cancelled writer ${writer.name} cannot take over`);
      store.takeOver(writer.generation);
      continue;
    }
    if (step.op === 'release-gate') {
      const gate = gates.get(step.gate);
      if (!gate) throw new Error(`unknown gate: ${step.gate}`);
      if (gate.released) throw new Error(`gate already released: ${step.gate}`);
      gate.released = true;
      gate.resolve();
      continue;
    }
    if (step.op === 'await-commit') {
      const writer = writerFor(step.writer);
      if (!writer.task) throw new Error(`writer ${writer.name} has no commit to await`);
      if (writer.awaited) throw new Error(`writer ${writer.name} commit awaited twice`);
      await writer.task;
      writer.awaited = true;
      continue;
    }
    throw new Error(`unknown operation: ${step.op}`);
  }

  for (const [name, writer] of Object.entries(writers)) {
    if (writer.task && !writer.awaited) throw new Error(`writer ${name} commit was not awaited`);
  }
  for (const [name, gate] of gates) {
    if (!gate.released) throw new Error(`gate was not released: ${name}`);
  }
  for (const attempt of attempts) {
    if (attempt.outcome === null) throw new Error(`commit by ${attempt.writer} did not finish`);
  }
  return {
    finalCache: store.snapshot(),
    captures,
    cancelled,
    earlyChecks,
    attempts,
    commitOrder,
  };
}

const rawRows = readFileSync(new URL('./writer-fencing-cases.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`writer-fencing-cases.jsonl line ${index + 1} is not JSON: ${error.message}`);
    }
  });

assert.equal(rawRows.length, 4, 'writer-fencing-cases.jsonl must contain four rows');
assert.deepEqual(rawRows.map((row) => row.id), IDS, 'writer-fencing case IDs must be stable and ordered');
assert.equal(new Set(IDS).size, 4);

for (const [index, rawRow] of rawRows.entries()) {
  test(`writer fencing: ${rawRow.id}`, async () => {
    assert.equal(rawRow.synthetic, true);
    assert.equal(rawRow.language, 'en');
    assert.equal(rawRow.license, 'MIT');
    assert.equal(typeof rawRow.task_prompt, 'string');
    assert.ok(rawRow.task_prompt.length > 100);
    assert.equal(typeof rawRow.provenance, 'string');
    assert.match(rawRow.provenance, /https:\/\/github\.com\/GoranStoyanov\/Poolser\/issues\/26/);
    assert.match(
      rawRow.provenance,
      /https:\/\/github\.com\/GoranStoyanov\/Poolser\/tree\/25927cac9b289af08753f2f4db7b59118c77e2e1/,
    );

    if (index === 0) {
      assert.throws(
        () => validateInput({ ...rawRow.input, policy: 'latest-wins' }),
        /unknown policy/,
      );
      assert.throws(
        () => validateInput({
          ...rawRow.input,
          schedule: [{ op: 'sleep', writer: 'A', milliseconds: 1 }],
        }),
        /unknown operation/,
      );
      assert.throws(
        () => validateInput({
          ...rawRow.input,
          initial_cache: { watermark: '100', rows: ['duplicate', 'duplicate'] },
        }),
        /duplicate event ID/,
      );
      assert.throws(
        () => validateInput({ ...rawRow.input, initial_cache: { watermark: '0100', rows: [] } }),
        /decimal string/,
      );
      assert.throws(
        () => validateInput({
          ...rawRow.input,
          writers: {
            A: { generation: '110' },
            B: { generation: 'gen-b-1' },
          },
        }),
        /not a block number/,
      );
      assert.throws(
        () => validateInput({
          ...rawRow.input,
          schedule: [{ op: 'await-commit', writer: 'missing' }],
        }),
        /writer must be A or B/,
      );
    }

    const input = validateInput(rawRow.input);
    const expected = rawRow.expected;
    const actual = await execute(input);

    assert.deepEqual(actual.finalCache, expected.final_cache);
    assert.deepEqual(actual.captures, expected.captures);
    assert.deepEqual(actual.cancelled, expected.cancelled);
    assert.deepEqual(actual.earlyChecks, expected.early_checks);
    assert.deepEqual(actual.commitOrder, expected.commit_order);
    assert.deepEqual(
      actual.attempts.map(({ writer, candidate, outcome, reason }) => ({
        writer,
        candidate,
        outcome,
        reason,
      })),
      expected.commits,
    );

    // A rejected commit must leave the cache unchanged at the commit decision.
    for (const attempt of actual.attempts) {
      if (attempt.outcome === 'rejected') {
        assert.deepEqual(attempt.cache_after, attempt.cache_before_write);
      }
    }
    // The final cache is the result of the last completed commit.
    const attemptsByWriter = new Map(actual.attempts.map((attempt) => [attempt.writer, attempt]));
    const lastWriter = actual.commitOrder.at(-1);
    assert.deepEqual(actual.finalCache, attemptsByWriter.get(lastWriter).cache_after);

    if (input.policy === 'cancel-only' || input.policy === 'early-check-only') {
      assert.equal(actual.finalCache.watermark, '110');
      assert.ok(!actual.finalCache.rows.includes('b-event'));
      assert.deepEqual(actual.commitOrder, ['B', 'A']);
      assert.deepEqual(actual.cancelled, ['A']);
    }
    if (rawRow.id === 'writer-fencing-early-check-only') {
      assert.equal(actual.earlyChecks[0].passed, true);
      assert.equal(actual.earlyChecks[0].writer, 'A');
      assert.equal(actual.earlyChecks[0].current_generation, 'gen-a-1');

      // Negative control: a pre-await check that starts stale must reject
      // immediately and leave the store untouched. It must not reach the
      // await/gate or write path.
      const staleInput = validateInput({
        scope: 'synthetic-scan-scope-1',
        policy: 'early-check-only',
        initial_cache: { watermark: '100', rows: [] },
        initial_generation: 'gen-b-1',
        writers: {
          A: { generation: 'gen-a-1' },
          B: { generation: 'gen-b-1' },
        },
        schedule: [
          { op: 'capture', writer: 'A' },
          { op: 'prepare', writer: 'A', watermark: '110', rows: ['a-event'] },
          { op: 'start-commit', writer: 'A' },
          { op: 'await-commit', writer: 'A' },
        ],
      });
      const staleResult = await execute(staleInput);
      assert.equal(staleResult.earlyChecks.length, 1);
      assert.equal(staleResult.earlyChecks[0].writer, 'A');
      assert.equal(staleResult.earlyChecks[0].passed, false);
      assert.equal(staleResult.earlyChecks[0].generation, 'gen-a-1');
      assert.equal(staleResult.earlyChecks[0].current_generation, 'gen-b-1');
      assert.equal(staleResult.attempts.length, 1);
      assert.equal(staleResult.attempts[0].writer, 'A');
      assert.deepEqual(staleResult.attempts[0].candidate, { watermark: '110', rows: ['a-event'] });
      assert.equal(staleResult.attempts[0].outcome, 'rejected');
      assert.match(
        staleResult.attempts[0].reason,
        /early-check-only rejected the write: stale generation at the early pre-await check/,
      );
      assert.deepEqual(staleResult.attempts[0].cache_before_write, {
        watermark: '100',
        rows: [],
      });
      assert.deepEqual(staleResult.attempts[0].cache_after, { watermark: '100', rows: [] });
      assert.deepEqual(staleResult.finalCache, { watermark: '100', rows: [] });
      assert.deepEqual(staleResult.commitOrder, ['A']);
    }
    if (rawRow.id === 'writer-fencing-commit-fenced') {
      const stale = actual.attempts.find((attempt) => attempt.writer === 'A');
      assert.equal(stale.outcome, 'rejected');
      assert.deepEqual(actual.finalCache, { watermark: '120', rows: ['b-event'] });
      assert.deepEqual(actual.earlyChecks, []);
      assert.ok(actual.commitOrder.indexOf('B') < actual.commitOrder.indexOf('A'));
    }
    if (rawRow.id === 'writer-fencing-current-writer-control') {
      assert.equal(input.initialGeneration, 'gen-b-1');
      assert.equal(actual.attempts.length, 1);
      assert.equal(actual.attempts[0].outcome, 'committed');
      assert.deepEqual(actual.finalCache, { watermark: '120', rows: ['b-event'] });
    }
  });
}
