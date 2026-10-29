import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base = process.env.NOTEBOOK_TEST_URL;
if (!base || !['localhost','127.0.0.1'].includes(new URL(base).hostname)) throw Error('Set NOTEBOOK_TEST_URL to an isolated loopback server with a temporary NOTEBOOK_DB_PATH.');
function client() {
  return { cookie: '', async call(path, method='GET', body, headers={}) {
    const res = await fetch(`${base}/api/${path}`, { method, headers: { Cookie:this.cookie, 'Content-Type':'application/json', 'X-Notebook-Request':'1', ...headers }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
    if (res.headers.get('set-cookie')) this.cookie=res.headers.get('set-cookie').split(';')[0];
    return { status:res.status, headers:res.headers, data:await res.json() };
  }};
}
test('multi-user notebook API', async t => {
  const a=client(), b=client(), guest=client();
  const suffix=randomUUID().slice(0,8), creds={username:`owner_${suffix}`,password:'long-test-password-123'};
  let personal, shared;
  await t.test('register and authenticated session', async()=>{
    const r=await a.call('auth/register','POST',creds);
    assert.equal(r.status,201); assert.match(r.headers.get('set-cookie'),/HttpOnly/); assert.match(r.headers.get('set-cookie'),/SameSite=Lax/);
    assert.equal((await a.call('auth/me')).data.user.username,creds.username);
    assert.equal((await b.call('auth/register','POST',{...creds,username:`peer_${suffix}`})).status,201);
  });
  await t.test('duplicate and invalid credentials rejected',async()=>{
    assert.equal((await guest.call('auth/register','POST',creds)).status,409);
    for(const password of ['short','あ'.repeat(25)]) assert.equal((await guest.call('auth/register','POST',{...creds,password})).status,400);
  });
  await t.test('login, wrong password, logout',async()=>{
    assert.equal((await guest.call('auth/login','POST',{...creds,password:'incorrect-password'})).status,401);
    assert.equal((await guest.call('auth/login','POST',creds)).status,200);
    assert.equal((await guest.call('auth/logout','POST')).status,200);
  });
  await t.test('guests cannot read or write notes',async()=>{
    assert.equal((await guest.call('notes')).status,401);
    assert.equal((await guest.call('notes','POST',{})).status,401);
  });
  await t.test('create private and shared notes',async()=>{
    const r=await a.call('notes','POST',{title:'学習',body:'秘密の学習記録',visibility:'private'});
    assert.equal(r.status,201); personal=r.data.note;
    const s=await a.call('notes','POST',{title:'共有',body:'みんなで学ぶ',visibility:'shared'});
    assert.equal(s.status,201); shared=s.data.note;
  });
  await t.test('private notes hidden from other users for all operations',async()=>{
    const list=(await b.call('notes')).data.notes;
    assert(!list.some(n=>n.id===personal.id)); assert(list.some(n=>n.id===shared.id));
    assert.equal((await b.call(`notes/${personal.id}`)).status,404);
    assert.equal((await b.call(`notes/${personal.id}`,'PUT',{...personal,body:'intrusion'})).status,404);
    assert.equal((await b.call(`notes/${personal.id}?revision=1`,'DELETE')).status,404);
  });
  await t.test('shared editing, owner-only visibility and deletion',async()=>{
    assert.equal((await b.call(`notes/${shared.id}`,'PUT',{...shared,visibility:'private'})).status,403);
    const r=await b.call(`notes/${shared.id}`,'PUT',{...shared,body:'仲間の追記'});
    assert.equal(r.status,200); assert.equal(r.data.note.revision,2);
    assert.equal((await b.call(`notes/${shared.id}?revision=2`,'DELETE')).status,403);
  });
  await t.test('stale edits and deletes cannot overwrite changes',async()=>{
    assert.equal((await a.call(`notes/${shared.id}`,'PUT',{...shared,body:'old'})).status,409);
    assert.equal((await a.call(`notes/${shared.id}?revision=1`,'DELETE')).status,409);
    assert.equal((await a.call(`notes/${shared.id}`)).data.note.body,'仲間の追記');
  });
  await t.test('making shared note private removes access',async()=>{
    const latest=(await a.call(`notes/${shared.id}`)).data.note;
    assert.equal((await a.call(`notes/${shared.id}`,'PUT',{...latest,visibility:'private'})).status,200);
    assert.equal((await b.call(`notes/${shared.id}`)).status,404);
  });
  await t.test('forged requests and invalid notes rejected',async()=>{
    assert.equal((await a.call('notes','POST',{}, {'X-Notebook-Request':''})).status,403);
    assert.equal((await a.call('notes','POST',{}, {Origin:'https://untrusted.example'})).status,403);
    for(const body of [{title:'',body:'',visibility:'private'},{title:'test',body:'',visibility:'invalid'},{title:'test',body:'x'.repeat(100001),visibility:'private'}]) assert.equal((await a.call('notes','POST',body)).status,400);
  });
  await t.test('owner deletion and logout invalidate access',async()=>{
    assert.equal((await a.call(`notes/${personal.id}?revision=1`,'DELETE')).status,200);
    assert.equal((await a.call(`notes/${personal.id}`)).status,404);
    const oldCookie=a.cookie;
    await a.call('auth/logout','POST'); a.cookie=oldCookie;
    assert.equal((await a.call('notes')).status,401);
  });
  await t.test('login attempt limit enforced',async()=>{
    for(let i=0;i<10;i++) assert.equal((await guest.call('auth/login','POST',{...creds,username:`absent_${suffix}`})).status,401);
    assert.equal((await guest.call('auth/login','POST',{...creds,username:`absent_${suffix}`})).status,429);
  });
});
