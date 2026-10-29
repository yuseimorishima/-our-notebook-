import Head from 'next/head';
import { useEffect, useState } from 'react';
import type { Note, User } from '../lib/db';

type ManagedUser = { id: number; username: string; disabled: number; shared_count: number };
async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`/api/${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Notebook-Request': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '処理に失敗しました。');
  return data;
}
export default function Admin() {
  const [user, setUser] = useState<User | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<{ id?: number; title: string; body: string; revision?: number } | null>(null);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (draft) event.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [draft]);
  async function load() {
    const data = await request('admin/users');
    setUsers(data.users); setNotes(data.shared);
  }
  useEffect(() => {
    request('auth/me').then(async data => {
      setUser(data.user);
      if (data.user?.is_admin) await load();
    }).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, []);
  async function act(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); await load(); setNotice(message); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function edit(note?: Note) {
    if (draft && !window.confirm('編集中の内容を破棄しますか？')) return;
    setDraft(note ? { id: note.id, title: note.title, body: note.body, revision: note.revision } : { title: '', body: '' });
  }
  return <>
    <Head><title>管理者ページ | みんなのノート</title><meta name="robots" content="noindex,nofollow" /></Head>
    <header className="topbar"><a href="/" className="brand">▤ <span>みんなのノート<small>ADMINISTRATION</small></span></a><a className="secondary" href="/">ノートへ戻る</a></header>
    <main className="admin-main">
      <span className="eyebrow">ADMINISTRATION</span><h1>管理者ページ</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {loading ? <p>確認しています…</p> : !user ? <p>管理者アカウントで<a className="text-button" href="/">ログイン</a>してください。</p> : !user.is_admin ? <section className="admin-box"><h2>管理者権限がありません</h2><p>あなたのユーザーIDは <strong>{user.id}</strong> です。サイトの所有者が公開先の環境変数で管理者を指定できます。</p><p>一般ユーザーはノートのページから自分のノートを保存できます。</p></section> : <>
        <p>利用者の状態と共有ノートを管理します。個人ノートの本文は表示しません。</p>
        <div className="admin-summary"><span>利用者 <strong>{users.length}</strong> 人</span><span>利用停止中 <strong>{users.filter(u => u.disabled).length}</strong> 人</span><span>共有ノート <strong>{notes.length}</strong> 件</span><button className="secondary" disabled={busy} onClick={() => act(load, '最新の内容を読み込みました')}>再読み込み</button></div>
        <p className="success" role="status">{notice}</p>
        <section className="admin-box"><h2>ユーザー管理</h2><p>利用停止するとログインできなくなり、現在のセッションも無効になります。ノートは保持されます。再開後は再ログインが必要です。</p><label className="search">ユーザーを検索<input value={search} onChange={e => setSearch(e.target.value)} placeholder="ユーザー名" /></label>
          <div className="admin-table-wrap"><table><thead><tr><th>ID</th><th>ユーザー名</th><th>状態</th><th>共有ノート数</th><th>操作</th></tr></thead><tbody>{users.filter(u => u.username.includes(search.toLowerCase())).map(u => <tr key={u.id}><td>{u.id}</td><td>{u.username}{u.id === user.id && '（自分・管理者）'}</td><td>{u.disabled ? '利用停止中' : '利用中'}</td><td>{u.shared_count}</td><td>{u.id !== user.id && <button className="secondary" disabled={busy} onClick={() => {
            if (window.confirm(`「${u.username}」を${u.disabled ? '利用再開' : '利用停止'}しますか？`)) act(() => request(`admin/users/${u.id}`, 'PUT', { disabled: !u.disabled }), '利用状態を変更しました');
          }}>{u.disabled ? '利用再開' : '利用停止'}</button>}</td></tr>)}</tbody></table></div>
        </section>
        <section className="admin-box"><h2>共有ノート管理</h2><p>ここで共有ノートを作成・編集・保存できます。削除は元に戻せません。</p><button className="primary" disabled={busy} onClick={() => edit()}>共有ノートを新規作成</button>
          {draft && <form className="admin-note-form" onSubmit={event => {
            event.preventDefault();
            act(async () => {
              await request(draft.id ? `notes/${draft.id}` : 'notes', draft.id ? 'PUT' : 'POST', { ...draft, visibility: 'shared' });
              setDraft(null);
            }, '共有ノートを保存しました');
          }}><h3>{draft.id ? '共有ノートを編集' : '新しい共有ノート'}</h3><label>タイトル<input required maxLength={120} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} disabled={busy} /></label><label htmlFor="admin-note-body">本文</label><textarea id="admin-note-body" maxLength={100000} value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} disabled={busy} /><p>保存すると登録ユーザー全員が閲覧・編集できます。</p><button className="primary" disabled={busy}>共有ノートを保存</button> <button className="secondary" type="button" disabled={busy} onClick={() => { if (window.confirm('編集中の内容を破棄しますか？')) setDraft(null); }}>キャンセル</button></form>}
          {notes.length === 0 ? <p>共有ノートはありません。</p> : notes.map(note => <article className="admin-note" key={note.id}><div><h3>{note.title}</h3><small>作成：{note.username} · ノートID {note.id}</small><p>{note.body.slice(0, 240)}{note.body.length > 240 && '…'}</p><button className="secondary" disabled={busy} onClick={() => edit(note)}>編集する</button></div><button className="delete-button" disabled={busy} onClick={() => {
          if (window.confirm(`共有ノート「${note.title}」を削除しますか？元には戻せません。`)) act(() => request(`admin/notes/${note.id}?revision=${note.revision}`, 'DELETE'), '共有ノートを削除しました');
        }}>共有ノートを削除</button></article>)}</section>
      </>}
    </main>
  </>;
}
