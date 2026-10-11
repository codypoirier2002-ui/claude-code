import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { openDb } from '../src/db.ts';
import { Auth } from '../src/auth.ts';

const withCookie = (setCookie: string) => ({ headers: { cookie: setCookie.split(';')[0] } }) as IncomingMessage;

test('changing the admin token ends sessions made with the old one; keeping it does not', () => {
  const db = openDb(path.join(mkdtempSync(path.join(tmpdir(), 'station-auth-')), 'station.sqlite'));
  const first = new Auth(db, 'token-a');
  const req = withCookie(first.login('token-a')!.cookie);
  assert.ok(first.session(req));

  assert.ok(new Auth(db, 'token-a').session(req), 'restart with the same token keeps the session');
  const rotated = new Auth(db, 'token-b');
  assert.equal(rotated.session(req), null, 'old session refused after rotation');
  assert.ok(rotated.session(withCookie(rotated.login('token-b')!.cookie)), 'new token logs in');
  db.close();
});
