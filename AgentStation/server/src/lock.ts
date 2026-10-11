// Single-instance lock helpers. The lock file holds the server's pid.
import { existsSync, readFileSync } from 'node:fs';

const HAS_PROC = existsSync('/proc/self/cmdline');

// True when pid is a running AgentStation server. After a reboot the pid in a
// stale lock file can belong to an unrelated process (on a VPS that boots the
// same way each time, possibly the OpenClaw gateway), so on Linux the
// process's command line must also name main.ts. Without /proc, any live
// process counts, which errs towards refusing to start.
export function isStationProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (!HAS_PROC) return true;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').some((arg) => arg.endsWith('main.ts'));
  } catch {
    return false;
  }
}
