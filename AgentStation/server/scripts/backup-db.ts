// Consistent copy of the station database while the server may be running
// (SQLite online backup API), followed by an integrity check of the copy.
//   node scripts/backup-db.ts <destination.sqlite>
import { DatabaseSync, backup } from 'node:sqlite';
import { loadConfig } from '../src/config.ts';

const dest = process.argv[2];
if (!dest) throw new Error('usage: backup-db.ts <destination.sqlite>');
const cfg = loadConfig();
const src = new DatabaseSync(cfg.dbPath, { readOnly: true });
const pages = await backup(src, dest);
src.close();
const copy = new DatabaseSync(dest, { readOnly: true });
const check = (copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
const tasks = (copy.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n;
copy.close();
if (check !== 'ok') throw new Error(`backup copy failed integrity check: ${check}`);
console.log(`database backed up (${pages} pages, ${tasks} tasks, integrity ok)`);
