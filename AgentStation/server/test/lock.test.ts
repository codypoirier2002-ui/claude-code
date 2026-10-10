import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isStationProcess } from '../src/lock.ts';

test('a stale lock whose pid now belongs to another process does not block startup', { skip: !existsSync('/proc/self/cmdline') && 'needs /proc' }, async () => {
  assert.equal(isStationProcess(process.pid), false, 'live, but not a station');
  assert.equal(isStationProcess(2 ** 22 + 1), false, 'no such process');
  assert.equal(isStationProcess(NaN), false);
  const station = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'src/main.ts'], { stdio: 'ignore' });
  try {
    await new Promise((r) => station.once('spawn', r));
    assert.equal(isStationProcess(station.pid!), true);
  } finally {
    station.kill();
  }
});
