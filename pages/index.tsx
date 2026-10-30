import Head from 'next/head';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Note, User } from '../lib/db';

type Reply = { user: User | null; notes: Note[]; note: Note };
async function api(path: string, method = 'GET', body?: unknown): Promise<Reply> {
  const res = await fetch(`/api/${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Notebook-Request': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || '通信に失敗しました。');
  return result;
}
const date = (value: string) => new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [register, setRegister] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [tab, setTab] = useState<'private' | 'shared'>('private');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Note | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dirty = editing && (selected ? title !== selected.title || body !== selected.body || visibility !== selected.visibility : !!title || !!body);
  useEffect(() => {
    api('auth/me').then(async data => {
      setUser(data.user);
      if (data.user) setNotes((await api('notes')).notes);
    }).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  const visible = useMemo(() => notes.filter(note => note.visibility === tab && `${note.title}\n${note.body}`.toLowerCase().includes(search.toLowerCase())), [notes, tab, search]);
  function mayLeave() { return !dirty || window.confirm('保存していない変更があります。変更を破棄しますか？'); }
  function open(note: Note | null) {
    if (!mayLeave()) return;
    setSelected(note); setTitle(note?.title || ''); setBody(note?.body || '');
    setVisibility(note?.visibility || tab); setEditing(true); setError(''); setNotice('');
  }
  function useTemplate(kind: 'study' | 'question' | 'idea') {
    if ((title || body) && !window.confirm('入力中の内容をテンプレートに置き換えますか？')) return;
    const templates = {
      study: { title: '今日の学習ノート', body: '【今日のテーマ】\n\n\n【学んだこと】\n\n\n【大事なポイント】\n\n\n【次にやること】\n' },
      question: { title: 'わからないことメモ', body: '【知りたいこと】\n\n\n【今わかっていること】\n\n\n【調べたこと・答え】\n\n\n【次に試すこと】\n' },
      idea: { title: 'みんなのアイデア', body: '【テーマ】\n\n\n【アイデア】\n\n\n【話し合いたいこと】\n\n\n【次の一歩】\n' }
    };
    setTitle(templates[kind].title); setBody(templates[kind].body); setNotice('テンプレートを入れました。自由に書き換えられます。'); setError('');
  }
  function downloadNote() {
    const filename = (title.trim() || 'ノート').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 100);
    const url = URL.createObjectURL(new Blob([`${title.trim() || '無題'}\n\n${body}`], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `${filename}.txt`;
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('表示中の内容をテキストファイルに書き出しました。');
  }
  async function authenticate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError('');
    const data = new FormData(e.currentTarget);
    try {
      const result = await api(register ? 'auth/register' : 'auth/login', 'POST', { username: data.get('username'), password: data.get('password') });
      setUser(result.user); setNotes((await api('notes')).notes);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (visibility === 'shared' && selected?.visibility !== 'shared' && !window.confirm('このノートを全ユーザーに公開します。全員が本文を編集できるようになります。続けますか？')) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { note } = await api(selected ? `notes/${selected.id}` : 'notes', selected ? 'PUT' : 'POST', { title, body, visibility, revision: selected?.revision });
      setSelected(note); setTitle(note.title); setBody(note.body); setVisibility(note.visibility); setTab(note.visibility);
      setNotes(old => [note, ...old.filter(n => n.id !== note.id)]); setNotice('保存しました');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function refresh() {
    if (!mayLeave()) return;
    setBusy(true); setError('');
    try {
      const result = (await api('notes')).notes; setNotes(result);
      if (selected) {
        const note = result.find(n => n.id === selected.id);
        if (note) { setSelected(note); setTitle(note.title); setBody(note.body); setVisibility(note.visibility); }
        else { setSelected(null); setEditing(false); }
      }
      setNotice('最新の内容を読み込みました');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!selected) {
      if ((title || body) && !window.confirm('作成中のノートを破棄しますか？')) return;
      setEditing(false); setTitle(''); setBody(''); setError(''); setNotice('作成中のノートを破棄しました');
      return;
    }
    if (!window.confirm(`「${selected.title}」を削除しますか？この操作は元に戻せません。`)) return;
    setBusy(true); setError('');
    try {
      await api(`notes/${selected.id}?revision=${selected.revision}`, 'DELETE');
      setNotes(old => old.filter(n => n.id !== selected.id)); setSelected(null); setEditing(false); setNotice('削除しました');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function logout() {
    if (!mayLeave()) return;
    setBusy(true); setError('');
    try { await api('auth/logout', 'POST'); setUser(null); setNotes([]); setSelected(null); setEditing(false); setTitle(''); setBody(''); setNotice(''); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <>
    <Head><title>みんなのノート</title><meta name="description" content="ひとりの学びも、みんなの発見も。一緒に育てるノート。" /><meta name="viewport" content="width=device-width, initial-scale=1" /></Head>
    {loading ? <main className="loading">ノートを開いています…</main> : !user ? <main className="welcome">
      <section className="intro"><span className="wordmark">▤ OUR NOTEBOOK</span><div><span className="eyebrow">ひとりで学ぶ。みんなで育てる。</span><h1>今日の発見を、<br />明日の自分と<br />みんなへ。</h1><p>自分だけの学習ノート。<br />仲間と書き足す共有ノート。<br />どちらも、ひとつの場所に。</p></div><span className="intro-footer">小さなメモから、学びは広がる。</span></section>
      <section className="auth-panel"><form onSubmit={authenticate} className="auth-card"><span className="eyebrow">WELCOME TO YOUR NOTEBOOK</span><h2>{register ? 'はじめの1ページを。' : 'おかえりなさい。'}</h2><p>{register ? 'ユーザー名とパスワードを決めて始めましょう。' : 'ログインして、学びの続きを始めましょう。'}</p>
        <label>ユーザー名<input name="username" required minLength={3} maxLength={30} autoComplete="username" placeholder="例：study_taro" /></label>
        <small>3〜30文字。文字・数字・_・- が使えます。</small>
        <label>パスワード<input name="password" type="password" required minLength={10} autoComplete={register ? 'new-password' : 'current-password'} placeholder="10文字以上" /></label>
        {register && <small>UTF-8で72バイト以内。長く推測されにくいものを使いましょう。</small>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary wide" disabled={busy}>{busy ? '確認しています…' : register ? 'アカウントを作成' : 'ログイン'} <span>→</span></button>
        <div className="auth-switch">{register ? 'アカウントをお持ちですか？' : '初めてご利用ですか？'} <button type="button" className="text-button" disabled={busy} onClick={() => { setRegister(!register); setError(''); }}>{register ? 'ログイン' : '新規登録'}</button></div>
      </form></section>
    </main> : <div className="workspace">
      <header className="topbar"><a href="/" onClick={e => { if (!mayLeave()) e.preventDefault(); }} className="brand">▤ <span>みんなのノート<small>OUR NOTEBOOK</small></span></a><div className="account"><span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span><span>{user.username}</span>{user.is_admin && <a className="text-button" href="/admin" onClick={e => { if (!mayLeave()) e.preventDefault(); }}>管理者ページ</a>}<button className="text-button" onClick={logout} disabled={busy}>ログアウト</button></div></header>
      <aside className="sidebar"><span className="eyebrow">YOUR LIBRARY</span><h1>学びの本棚</h1><button className="primary wide" disabled={busy} onClick={() => open(null)}>＋ 新しいノート</button>
        <nav aria-label="ノートの種類">{(['private', 'shared'] as const).map(value => <button key={value} disabled={busy} className={`nav-item ${tab === value ? 'active' : ''}`} onClick={() => { if (!mayLeave()) return; setTab(value); setSelected(null); setEditing(false); setError(''); setNotice(''); }}><span>{value === 'private' ? '▧ 自分の学習ノート' : '▦ みんなの共有ノート'}</span><span>{notes.filter(n => n.visibility === value).length}</span></button>)}</nav>
        <div className="sidebar-tip"><span>✦ 少しずつ、積み重ねる。</span><p>気づいたこと、わからないこと。<br />まずは言葉にしてみよう。</p></div><small className="privacy-note">個人ノートは自分だけ。<br />共有ノートは登録ユーザー全員が<br />閲覧・編集できます。</small>
      </aside>
      <main className="desk"><div className="section-heading"><div><span className="eyebrow">{tab === 'private' ? 'MY STUDY NOTES' : 'SHARED WITH EVERYONE'}</span><h2>{tab === 'private' ? '自分の学習ノート' : 'みんなの共有ノート'}</h2><p>{tab === 'private' ? '自分のペースで、学びを残そう。' : 'アイデアを持ち寄って、一緒に育てよう。'}</p></div><button className="secondary" onClick={refresh} disabled={busy}>↻ 再読み込み</button></div>
        <div className="feedback" aria-live="polite">{error ? <p className="error" role="alert">{error}</p> : notice ? <p className="success">✓ {notice}</p> : <p>共有ノートの変更は「再読み込み」で確認できます。</p>}</div>
        <div className="notebook-grid"><section className="note-list" aria-label="ノート一覧"><label className="search"><span className="sr-only">ノートを検索</span><input value={search} onChange={e => setSearch(e.target.value)} placeholder="タイトル・本文を検索…" /></label><span className="count">{visible.length} 件のノート</span>
          {visible.length === 0 ? <div className="list-empty">{search ? '一致するノートはありません。' : 'まだノートがありません。最初の1ページを書いてみましょう。'}</div> : visible.map(note => <button disabled={busy} className={`note-card ${selected?.id === note.id ? 'selected' : ''}`} key={note.id} onClick={() => open(note)}><span className="note-date">{date(note.updated_at)}</span><h3>{note.title}</h3><p>{note.body || '本文はまだありません。'}</p><span className="note-author">{note.visibility === 'private' ? '自分だけ' : `作成：${note.username}`}</span></button>)}
        </section>
        <section className="editor" aria-label="ノート編集">{!editing ? <div className="empty-editor"><span className="paper-icon">▤</span><h3>ここから、次の発見を。</h3><p>ノートを選んで続きを書くか、<br />新しいノートを作ってみましょう。</p><button className="secondary" disabled={busy} onClick={() => open(null)}>＋ ノートを作成</button></div> : <form onSubmit={save} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!busy) event.currentTarget.requestSubmit(); } }}><div className="editor-toolbar"><span className="eyebrow">{selected ? 'NOTEBOOK' : 'NEW NOTEBOOK'} {dirty && '・未保存'}</span><div className="editor-actions"><button type="button" className="secondary" onClick={downloadNote} disabled={busy}>書き出す</button><button className="primary" disabled={busy}>{busy ? '処理中…' : '保存する'}</button></div></div>
          {!selected && <div className="templates"><span>書き始めに迷ったら</span><div><button type="button" disabled={busy} onClick={() => useTemplate('study')}>✦ 学習メモ</button><button type="button" disabled={busy} onClick={() => useTemplate('question')}>？ 疑問メモ</button><button type="button" disabled={busy} onClick={() => useTemplate('idea')}>＋ アイデア</button></div></div>}
          <label className="sr-only" htmlFor="note-title">タイトル</label><input id="note-title" className="title-input" value={title} onChange={e => setTitle(e.target.value)} maxLength={120} placeholder="ノートのタイトル" required disabled={busy} />
          <div className="note-meta"><label>公開範囲 <select value={visibility} onChange={e => setVisibility(e.target.value as 'private' | 'shared')} disabled={busy || (!!selected && selected.owner_id !== user.id)}><option value="private">自分だけ</option><option value="shared">みんなに共有</option></select></label>{selected && <small>作成：{selected.username}</small>}</div>
          <label className="sr-only" htmlFor="note-body">本文</label><textarea id="note-body" value={body} onChange={e => setBody(e.target.value)} maxLength={100000} placeholder="今日学んだこと、気づいたことを書いてみましょう…" disabled={busy} />
          <div className="editor-footer"><small>{body.length.toLocaleString()} 文字{selected && ` · 更新 ${date(selected.updated_at)}`}</small>{(!selected || selected.owner_id === user.id) && <button type="button" className="delete-button" onClick={remove} disabled={busy}>{selected ? 'ノートを削除' : '作成をやめる'}</button>}</div>
        </form>}</section></div>
      </main>
    </div>}
  </>;
}
