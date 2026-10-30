import type { Client, InValue } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let connection: Promise<Client> | undefined;
async function connect(): Promise<Client> {
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  let client: Client;
  if (url || token) {
    if (!url || !token || !/^(libsql|https):\/\//.test(url)) {
      throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must both be configured for a remote database');
    }
    const { createClient } = await import('@libsql/client/web');
    client = createClient({ url, authToken: token });
  } else {
    if (process.env.VERCEL) throw new Error('Configure Turso before deploying: local SQLite cannot persist on Vercel');
    const path = resolve(/* turbopackIgnore: true */ process.env.NOTEBOOK_DB_PATH || 'data/notebook.sqlite');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const { createClient } = await import('@libsql/client');
    client = createClient({ url: pathToFileURL(path).href });
  }
  try {
    await client.executeMultiple(schema);
    const columns = await client.execute('PRAGMA table_info(users)');
    if (!columns.rows.some(column => column.name === 'disabled')) {
      try { await client.execute('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0'); }
      catch (error) {
        const latest = await client.execute('PRAGMA table_info(users)');
        if (!latest.rows.some(column => column.name === 'disabled')) throw error;
      }
    }
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
function ready(): Promise<Client> {
  if (!connection) connection = connect().catch(error => { connection = undefined; throw error; });
  return connection;
}

// Both local development and Turso use the same async queries and schema.
export const db = {
  ready,
  async batch(statements: { sql: string; args: InValue[] }[]) {
    return (await ready()).batch(statements, 'write');
  },
  prepare(sql: string) {
    const execute = async (args: InValue[]) => (await ready()).execute({ sql, args });
    return {
      async get<T = unknown>(...args: InValue[]): Promise<T | undefined> { return (await execute(args)).rows[0] as unknown as T | undefined; },
      async all(...args: InValue[]) { return (await execute(args)).rows; },
      async run(...args: InValue[]) {
        const result = await execute(args);
        return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid ?? 0n };
      }
    };
  }
};

const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL CHECK(visibility IN ('private', 'shared')),
    revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS note_shares (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS notes_owner ON notes(owner_id);
`;

export type User = { id: number; username: string; is_admin: boolean };
export type Note = { id: number; owner_id: number; username: string; title: string; body: string; visibility: 'private' | 'shared'; revision: number; created_at: string; updated_at: string };
export const noteQuery = 'SELECT notes.*, users.username FROM notes JOIN users ON users.id = notes.owner_id';
