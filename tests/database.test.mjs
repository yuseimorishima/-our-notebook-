import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
function run(code, overrides = {}) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; delete env.TURSO_DATABASE_URL; delete env.TURSO_AUTH_TOKEN; delete env.VERCEL;
  return spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { env: { ...env, ...overrides }, encoding: 'utf8' });
}
test('serverless deployment cannot silently save to an ephemeral file', () => {
  const result = run("import assert from 'node:assert/strict'; import {db} from './lib/db.ts'; await assert.rejects(db.ready(), /Configure Turso/);", { VERCEL: '1' });
  assert.equal(result.status, 0, result.stderr);
});
test('partial remote credentials fail instead of switching to local storage', () => {
  const result = run("import assert from 'node:assert/strict'; import {db} from './lib/db.ts'; await assert.rejects(db.ready(), /must both be configured/);", { TURSO_DATABASE_URL: 'libsql://example.turso.io' });
  assert.equal(result.status, 0, result.stderr);
});
test('existing local users and notes survive the admin schema upgrade', () => {
  const directory = mkdtempSync(join(tmpdir(), 'notebook-migration-'));
  try {
    const result = run(`
      import assert from 'node:assert/strict';
      import {createClient} from '@libsql/client';
      import {pathToFileURL} from 'node:url';
      const original=createClient({url:pathToFileURL(process.env.NOTEBOOK_DB_PATH).href});
      await original.executeMultiple("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL); INSERT INTO users VALUES (7, 'existing-user', 'existing-hash'); CREATE TABLE notes(id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,visibility TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); INSERT INTO notes VALUES(5,7,'existing-note','existing-body','private',1,'now','now');");
      original.close();
      const {db}=await import('./lib/db.ts');
      const user=await db.prepare('SELECT * FROM users WHERE id=7').get();
      assert.equal(user.username,'existing-user'); assert.equal(user.password_hash,'existing-hash'); assert.equal(user.disabled,0);
      assert.equal((await db.prepare('SELECT body FROM notes WHERE id=5').get()).body,'existing-body');
      (await db.ready()).close();
    `, { NOTEBOOK_DB_PATH: join(directory, 'existing.sqlite') });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
