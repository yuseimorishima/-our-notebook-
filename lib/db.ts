import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const path = resolve(/* turbopackIgnore: true */ process.env.NOTEBOOK_DB_PATH || 'data/notebook.sqlite');
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
export const db = new Database(path);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL
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
  CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS notes_owner ON notes(owner_id);
`);

export type User = { id: number; username: string };
export type Note = { id: number; owner_id: number; username: string; title: string; body: string; visibility: 'private' | 'shared'; revision: number; created_at: string; updated_at: string };
export const noteQuery = 'SELECT notes.*, users.username FROM notes JOIN users ON users.id = notes.owner_id';
