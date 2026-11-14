import test from 'node:test';
import assert from 'node:assert/strict';
import { duration } from '../apps/shared/dom.js';

test('running durations use elapsed wall time in tenths and finished durations remain fixed', () => {
  const started = Date.parse('2026-11-14T08:00:00Z');
  const run = { status: 'running', started_at: new Date(started).toISOString() };
  assert.equal(duration(run, started + 100), '0.1 s');
  assert.equal(duration(run, started + 12700), '12.7 s');
  assert.equal(duration(run, started - 1000), '0.0 s');
  assert.equal(duration({ status: 'running' }, started), '—');
  assert.equal(duration({ status: 'queued' }, started), '—');
  const finished = { ...run, status: 'completed', metrics: { durationMs: 12345 } };
  assert.equal(duration(finished, started + 60000), '12.3 s');
  assert.equal(duration(finished, started + 120000), '12.3 s');
});
