import type { NextApiRequest, NextApiResponse } from 'next';
import { randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, noteQuery, type User, type Note } from '../../lib/db';

export const config = { api: { bodyParser: { sizeLimit: '256kb' } } };
const cookieName = 'notebook_session';
const duration = 7 * 24 * 60 * 60;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const dummyHash = bcrypt.hashSync('dummy-password-for-timing', 12);
class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function fail(status: number, message: string): never { throw new ApiError(status, message); }
function setSession(res: NextApiResponse, token: string, age = duration) {
  const secure = process.env.NOTEBOOK_COOKIE_SECURE === 'true' || (process.env.NOTEBOOK_COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production');
  res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`);
}
function getUser(req: NextApiRequest): User | undefined {
  const token = req.cookies[cookieName];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return;
  return db.prepare(`SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?`).get(digest(token), Date.now()) as User | undefined;
}
function throttle(key: string) {
  const now = Date.now();
  db.prepare('DELETE FROM attempts WHERE reset_at < ?').run(now);
  db.prepare('INSERT INTO attempts VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1').run(key, now + 15 * 60 * 1000);
  const row = db.prepare('SELECT count FROM attempts WHERE key = ?').get(key) as { count: number };
  if (row.count > 10) fail(429, '試行回数が多すぎます。15分ほど待ってからお試しください。');
}
function inputNote(body: Record<string, unknown>) {
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 120) fail(400, 'タイトルを1〜120文字で入力してください。');
  if (typeof body.body !== 'string' || body.body.length > 100000) fail(400, '本文は100,000文字以内で入力してください。');
  if (body.visibility !== 'private' && body.visibility !== 'shared') fail(400, '公開範囲が正しくありません。');
  return { title: body.title.trim(), body: body.body, visibility: body.visibility };
}
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const path = (req.query.route as string[] || []).join('/');
    const method = req.method;
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method || '')) fail(405, '対応していない操作です。');
    if (method !== 'GET') {
      if (req.headers['x-notebook-request'] !== '1') fail(403, 'リクエストを確認できませんでした。');
      if (req.headers.origin) {
        const expected = process.env.APP_ORIGIN || `http://${req.headers.host}`;
        if (new URL(req.headers.origin).host !== new URL(expected).host || (process.env.APP_ORIGIN && req.headers.origin !== process.env.APP_ORIGIN)) fail(403, '別のサイトからの操作は許可されていません。');
      }
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (path === 'auth/me' && method === 'GET') return res.json({ user: getUser(req) || null });
    if (['auth/register', 'auth/login'].includes(path) && method === 'POST') {
      const username = typeof body.username === 'string' ? body.username.normalize('NFKC').trim().toLowerCase() : '';
      if (!/^[\p{L}\p{N}_-]{3,30}$/u.test(username)) fail(400, 'ユーザー名は文字・数字・_・-を使い、3〜30文字にしてください。');
      if (typeof body.password !== 'string' || body.password.length < 10 || Buffer.byteLength(body.password, 'utf8') > 72) fail(400, 'パスワードは10文字以上、UTF-8で72バイト以内にしてください。');
      throttle(`auth:${req.socket.remoteAddress || 'local'}:${username}`);
      if (path === 'auth/register') {
        throttle(`register:${req.socket.remoteAddress || 'local'}`);
        const hash = await bcrypt.hash(body.password, 12);
        try { db.prepare('INSERT INTO users(username, password_hash) VALUES (?, ?)').run(username, hash); }
        catch (e) {
          if ((e as {code?: string}).code === 'SQLITE_CONSTRAINT_UNIQUE') fail(409, 'このユーザー名はすでに使われています。');
          throw e;
        }
      }
      const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as (User & { password_hash: string }) | undefined;
      const valid = await bcrypt.compare(body.password, row?.password_hash || dummyHash);
      if (!row || !valid) fail(401, 'ユーザー名またはパスワードが違います。');
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
      if (req.cookies[cookieName]) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(req.cookies[cookieName]));
      const token = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), row.id, Date.now() + duration * 1000);
      setSession(res, token);
      return res.status(path === 'auth/register' ? 201 : 200).json({ user: { id: row.id, username: row.username } });
    }
    const user = getUser(req);
    if (!user) fail(401, 'ログインしてください。');
    if (path === 'auth/logout' && method === 'POST') {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(req.cookies[cookieName]!));
      setSession(res, '', 0);
      return res.json({ ok: true });
    }
    if (path === 'notes' && method === 'GET') {
      const notes = db.prepare(`${noteQuery} WHERE owner_id = ? OR visibility = 'shared' ORDER BY updated_at DESC, notes.id DESC`).all(user.id);
      return res.json({ notes });
    }
    if (path === 'notes' && method === 'POST') {
      const note = inputNote(body);
      const now = new Date().toISOString();
      const result = db.prepare('INSERT INTO notes(owner_id, title, body, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, note.title, note.body, note.visibility, now, now);
      return res.status(201).json({ note: db.prepare(`${noteQuery} WHERE notes.id = ?`).get(result.lastInsertRowid) });
    }
    if (/^notes\/\d+$/.test(path)) {
      const id = Number(path.split('/')[1]);
      const note = db.prepare(`${noteQuery} WHERE notes.id = ? AND (owner_id = ? OR visibility = 'shared')`).get(id, user.id) as Note | undefined;
      if (!note) fail(404, 'ノートが見つかりません。');
      if (method === 'GET') return res.json({ note });
      if (method === 'PUT') {
        const value = inputNote(body);
        if (note.owner_id !== user.id && value.visibility !== note.visibility) fail(403, '公開範囲を変更できるのは作成者だけです。');
        if (!Number.isInteger(body.revision)) fail(400, 'ノートのバージョンが必要です。');
        const result = db.prepare('UPDATE notes SET title = ?, body = ?, visibility = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?').run(value.title, value.body, value.visibility, new Date().toISOString(), id, body.revision);
        if (!result.changes) fail(409, '他の人が更新しました。再読み込みして最新の内容を確認してください。入力内容はそのまま残っています。');
        return res.json({ note: db.prepare(`${noteQuery} WHERE notes.id = ?`).get(id) });
      }
      if (method === 'DELETE') {
        if (note.owner_id !== user.id) fail(403, '削除できるのは作成者だけです。');
        const result = db.prepare('DELETE FROM notes WHERE id = ? AND revision = ?').run(id, Number(req.query.revision));
        if (!result.changes) fail(409, 'ノートが更新されています。再読み込みしてください。');
        return res.json({ ok: true });
      }
    }
    fail(404, 'この操作は見つかりません。');
  } catch (error) {
    if (error instanceof ApiError) return res.status(error.status).json({ error: error.message });
    console.error('Notebook API error:', error instanceof Error ? error.message : 'unknown');
    return res.status(500).json({ error: '処理に失敗しました。時間をおいて再度お試しください。' });
  }
}
