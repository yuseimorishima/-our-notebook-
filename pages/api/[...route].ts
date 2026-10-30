import type { NextApiRequest, NextApiResponse } from 'next';
import { randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, noteQuery, type User, type Note } from '../../lib/db';

export const config = { api: { bodyParser: { sizeLimit: '256kb' } } };
const cookieName = 'notebook_session';
const duration = 7 * 24 * 60 * 60;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const isAdmin = (id: number) => String(id) === process.env.ADMIN_USER_ID;
const dummyHash = bcrypt.hashSync('dummy-password-for-timing', 12);
class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function fail(status: number, message: string): never { throw new ApiError(status, message); }
function setSession(res: NextApiResponse, token: string, age = duration) {
  const secure = process.env.NOTEBOOK_COOKIE_SECURE === 'true' || (process.env.NOTEBOOK_COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production');
  res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`);
}
async function getUser(req: NextApiRequest): Promise<User | undefined> {
  const token = req.cookies[cookieName];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return;
  const row = await db.prepare(`SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ? AND users.disabled = 0`).get(digest(token), Date.now()) as User | undefined;
  return row ? { ...row, is_admin: isAdmin(row.id) } : undefined;
}
async function throttle(key: string) {
  const now = Date.now();
  await db.prepare('DELETE FROM attempts WHERE reset_at < ?').run(now - 24 * 60 * 60 * 1000);
  const row = await db.prepare(`INSERT INTO attempts VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN attempts.reset_at <= ? THEN 1 ELSE attempts.count + 1 END,
      reset_at = CASE WHEN attempts.reset_at <= ? THEN excluded.reset_at ELSE attempts.reset_at END
    RETURNING count`).get(key, now + 15 * 60 * 1000, now, now) as { count: number };
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
    if (path === 'auth/me' && method === 'GET') {
      await db.ready();
      return res.json({ user: (await getUser(req)) || null });
    }
    if (['auth/register', 'auth/login'].includes(path) && method === 'POST') {
      const username = typeof body.username === 'string' ? body.username.normalize('NFKC').trim().toLowerCase() : '';
      if (!/^[\p{L}\p{N}_-]{3,30}$/u.test(username)) fail(400, 'ユーザー名は文字・数字・_・-を使い、3〜30文字にしてください。');
      if (typeof body.password !== 'string' || body.password.length < 10 || Buffer.byteLength(body.password, 'utf8') > 72) fail(400, 'パスワードは10文字以上、UTF-8で72バイト以内にしてください。');
      await throttle(`auth:${req.socket.remoteAddress || 'local'}:${username}`);
      if (path === 'auth/register') {
        await throttle(`register:${req.socket.remoteAddress || 'local'}`);
        const hash = await bcrypt.hash(body.password, 12);
        try { await db.prepare('INSERT INTO users(username, password_hash) VALUES (?, ?)').run(username, hash); }
        catch (e) {
          const constraint = e as { code?: string; rawCode?: number; message?: string };
          if (constraint.code === 'SQLITE_CONSTRAINT_UNIQUE' || (constraint.code === 'SQLITE_CONSTRAINT' && (constraint.rawCode === 2067 || constraint.message?.includes('UNIQUE constraint failed: users.username')))) fail(409, 'このユーザー名はすでに使われています。');
          throw e;
        }
      }
      const row = await db.prepare('SELECT * FROM users WHERE username = ?').get(username) as (User & { password_hash: string; disabled: number }) | undefined;
      const valid = await bcrypt.compare(body.password, row?.password_hash || dummyHash);
      if (!row || !valid || row.disabled) fail(401, 'ユーザー名またはパスワードが違います。');
      await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
      if (req.cookies[cookieName]) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(req.cookies[cookieName]));
      const token = randomBytes(32).toString('hex');
      await db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), row.id, Date.now() + duration * 1000);
      setSession(res, token);
      return res.status(path === 'auth/register' ? 201 : 200).json({ user: { id: row.id, username: row.username, is_admin: isAdmin(row.id) } });
    }
    const user = await getUser(req);
    if (!user) fail(401, 'ログインしてください。');
    if (path.startsWith('admin/')) {
      if (!user.is_admin) fail(403, '管理者だけが操作できます。');
      if (path === 'admin/users' && method === 'GET') {
        const users = await db.prepare(`SELECT users.id, users.username, users.disabled,
          (SELECT count(*) FROM notes WHERE owner_id = users.id AND visibility = 'shared') AS shared_count
          FROM users ORDER BY users.id`).all();
        return res.json({ users, shared: await db.prepare(`${noteQuery} WHERE visibility = 'shared' ORDER BY notes.id DESC`).all() });
      }
      if (/^admin\/users\/\d+$/.test(path) && method === 'PUT') {
        const id = Number(path.split('/')[2]);
        if (id === user.id) fail(400, '自分自身を利用停止にはできません。');
        if (typeof body.disabled !== 'boolean') fail(400, '利用状態が正しくありません。');
        if (!await db.prepare('SELECT id FROM users WHERE id = ?').get(id)) fail(404, 'ユーザーが見つかりません。');
        await db.batch([
          { sql: 'UPDATE users SET disabled = ? WHERE id = ?', args: [body.disabled ? 1 : 0, id] },
          { sql: 'DELETE FROM sessions WHERE user_id = ?', args: [id] }
        ]);
        return res.json({ ok: true });
      }
      if (/^admin\/notes\/\d+$/.test(path) && method === 'DELETE') {
        const id = Number(path.split('/')[2]);
        const note = await db.prepare("SELECT id, revision FROM notes WHERE id = ? AND visibility = 'shared'").get(id) as { id: number; revision: number } | undefined;
        if (!note) fail(404, '共有ノートが見つかりません。');
        const result = await db.prepare("DELETE FROM notes WHERE id = ? AND revision = ? AND visibility = 'shared'").run(id, Number(req.query.revision));
        if (!result.changes) fail(409, 'ノートが変更されています。再読み込みしてください。');
        return res.json({ ok: true });
      }
      fail(404, 'この管理操作は見つかりません。');
    }
    if (path === 'auth/logout' && method === 'POST') {
      await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(req.cookies[cookieName]!));
      setSession(res, '', 0);
      return res.json({ ok: true });
    }
    if (path === 'notes' && method === 'GET') {
      const notes = await db.prepare(`${noteQuery} WHERE owner_id = ? OR visibility = 'shared' OR EXISTS (SELECT 1 FROM note_shares WHERE note_id = notes.id AND user_id = ?) ORDER BY updated_at DESC, notes.id DESC`).all(user.id, user.id);
      return res.json({ notes });
    }
    if (path === 'notes' && method === 'POST') {
      const note = inputNote(body);
      const now = new Date().toISOString();
      const result = await db.prepare('INSERT INTO notes(owner_id, title, body, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, note.title, note.body, note.visibility, now, now);
      return res.status(201).json({ note: await db.prepare(`${noteQuery} WHERE notes.id = ?`).get(result.lastInsertRowid) });
    }
    if (/^notes\/\d+\/shares$/.test(path)) {
      const id = Number(path.split('/')[1]);
      const ownerNote = await db.prepare('SELECT id, visibility FROM notes WHERE id = ? AND owner_id = ?').get(id, user.id) as {id:number;visibility:string} | undefined;
      if (!ownerNote) fail(404, 'ノートが見つかりません。');
      if (method === 'GET') {
        const shares = await db.prepare('SELECT users.username FROM note_shares JOIN users ON users.id = note_shares.user_id WHERE note_id = ? ORDER BY users.username').all(id);
        return res.json({ usernames: shares.map(row => row.username) });
      }
      if (method === 'PUT') {
        if (ownerNote.visibility !== 'private') fail(400, '特定の人に共有するには、公開範囲を「自分だけ」にして保存してください。');
        if (!Array.isArray(body.usernames) || body.usernames.length > 50 || !body.usernames.every((name: unknown) => typeof name === 'string' && /^[\p{L}\p{N}_-]{3,30}$/u.test(name.normalize('NFKC').trim().toLowerCase()))) fail(400, '共有先のユーザー名を確認してください。');
        const names = [...new Set((body.usernames as string[]).map(name => name.normalize('NFKC').trim().toLowerCase()))];
        if (names.includes(user.username)) fail(400, '自分のユーザー名は指定しなくて大丈夫です。');
        const tx = await (await db.ready()).transaction('write');
        try {
          const current = await tx.execute({sql:'SELECT id FROM notes WHERE id = ? AND owner_id = ? AND visibility = ?',args:[id,user.id,'private']});
          if (!current.rows.length) fail(409, 'ノートの設定が変更されました。再読み込みしてください。');
          const recipients: number[] = [];
          for (const name of names) {
            const result = await tx.execute({sql:'SELECT id FROM users WHERE username = ? AND disabled = 0',args:[name]});
            if (!result.rows.length) fail(400, `ユーザー「${name}」が見つかりません。`);
            recipients.push(Number(result.rows[0].id));
          }
          await tx.execute({sql:'DELETE FROM note_shares WHERE note_id = ?',args:[id]});
          for (const recipient of recipients) await tx.execute({sql:'INSERT INTO note_shares(note_id,user_id) VALUES (?,?)',args:[id,recipient]});
          await tx.commit();
        } catch (error) { await tx.rollback(); throw error; }
        return res.json({usernames:names});
      }
    }
    if (/^notes\/\d+$/.test(path)) {
      const id = Number(path.split('/')[1]);
      const note = await db.prepare(`${noteQuery} WHERE notes.id = ? AND (owner_id = ? OR visibility = 'shared' OR EXISTS (SELECT 1 FROM note_shares WHERE note_id = notes.id AND user_id = ?))`).get(id, user.id, user.id) as Note | undefined;
      if (!note) fail(404, 'ノートが見つかりません。');
      if (method === 'GET') return res.json({ note });
      if (method === 'PUT') {
        const value = inputNote(body);
        if (note.owner_id !== user.id && value.visibility !== note.visibility) fail(403, '公開範囲を変更できるのは作成者だけです。');
        if (!Number.isInteger(body.revision)) fail(400, 'ノートのバージョンが必要です。');
        const tx = await (await db.ready()).transaction('write');
        try {
          const result = await tx.execute({sql:`UPDATE notes SET title = ?, body = ?, visibility = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND (owner_id = ? OR (visibility = ? AND ? = ?) OR (visibility = ? AND ? = ? AND EXISTS (SELECT 1 FROM note_shares WHERE note_id = notes.id AND user_id = ?)))`,args:[value.title,value.body,value.visibility,new Date().toISOString(),id,body.revision,user.id,'shared',value.visibility,'shared','private',value.visibility,'private',user.id]});
          if (!result.rowsAffected) fail(409, 'ノートが変更されたか、編集権限がなくなりました。再読み込みしてください。');
          if (note.owner_id === user.id && value.visibility === 'shared') await tx.execute({sql:'DELETE FROM note_shares WHERE note_id = ?',args:[id]});
          await tx.commit();
        } catch (error) { await tx.rollback(); throw error; }
        return res.json({ note: await db.prepare(`${noteQuery} WHERE notes.id = ?`).get(id) });
      }
      if (method === 'DELETE') {
        if (note.owner_id !== user.id) fail(403, '削除できるのは作成者だけです。');
        const tx = await (await db.ready()).transaction('write');
        try {
          await tx.execute({sql:'DELETE FROM note_shares WHERE note_id = ?',args:[id]});
          const result = await tx.execute({sql:'DELETE FROM notes WHERE id = ? AND owner_id = ? AND revision = ?',args:[id,user.id,Number(req.query.revision)]});
          if (!result.rowsAffected) fail(409, 'ノートが更新されています。再読み込みしてください。');
          await tx.commit();
        } catch (error) { await tx.rollback(); throw error; }
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
