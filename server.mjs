// UseMy small app: Message Board
// Public board (anonymous, threaded, bot-challenged) on PORT.
// Owner manager (reply as owner, edit, delete/restore) on MANAGE_PORT.
// Two HTTP servers, one process, shared store. No external dependencies.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomInt } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '18860', 10);
const MANAGE_PORT = parseInt(process.env.MANAGE_PORT || '18861', 10);
const DATA_FILE = process.env.DATA_FILE || resolve(HERE, 'data', 'messages.json');
const MAX_LEN = 2000;
const RATE_MAX = 6;            // max posts ...
const RATE_WINDOW = 60_000;    // ... per minute per ip

// ---------- storage ----------
function load() {
  try { const d = JSON.parse(readFileSync(DATA_FILE, 'utf8')); if (!Array.isArray(d.messages)) d.messages = []; return d; }
  catch { return { messages: [] }; }
}
let db = load();
function save() {
  const dir = dirname(DATA_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, DATA_FILE);
}

// ---------- helpers ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function sendJson(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function sendHtml(res, code, html) { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }); res.end(html); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 100_000) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
function fmtTime(ts) { const d = new Date(ts); return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }

// ---------- challenge (simple anti-bot) ----------
const challenges = new Map(); // token -> { answer, exp }
function newChallenge() { const a = randomInt(1, 10), b = randomInt(1, 10); const token = randomUUID(); challenges.set(token, { answer: a + b, exp: Date.now() + 600_000 }); return { token, question: `What is ${a} + ${b}?` }; }
function checkChallenge(token, answer) { const c = challenges.get(token); if (!c) return false; challenges.delete(token); if (c.exp < Date.now()) return false; return parseInt(answer, 10) === c.answer; }
setInterval(() => { const now = Date.now(); for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k); }, 300_000).unref();

// ---------- rate limit ----------
const hits = new Map(); // ip -> [ts]
function rateOk(ip) { const now = Date.now(); const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW); if (arr.length >= RATE_MAX) { hits.set(ip, arr); return false; } arr.push(now); hits.set(ip, arr); return true; }

// ---------- message ops ----------
function addMessage({ parentId = null, body, isOwner = false }) {
  const m = { id: randomUUID(), parentId: parentId || null, body, isOwner: !!isOwner, createdAt: Date.now(), editedAt: null, deleted: false };
  db.messages.push(m); save(); return m;
}
const findMsg = (id) => db.messages.find((m) => m.id === id);
function buildTree() {
  const byId = new Map(); const roots = [];
  for (const m of db.messages) byId.set(m.id, { ...m, children: [] });
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) byId.get(node.parentId).children.push(node);
    else roots.push(node);
  }
  const sortRec = (nodes) => { nodes.sort((a, b) => a.createdAt - b.createdAt); nodes.forEach((n) => sortRec(n.children)); };
  sortRec(roots);
  return roots;
}
const hasVisibleDescendant = (node) => node.children.some((c) => (!c.deleted) || hasVisibleDescendant(c));

// ---------- shared styles ----------
const STYLE = `
:root{--bg:#0f1115;--card:#181b22;--card2:#1f232c;--ink:#e8eaed;--mut:#9aa3b2;--line:#2a2f3a;--owner:#d98a3d;--accent:#5b8def;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:28px 18px 80px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 22px;font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:10px 0}
.msg{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:10px 0}
.msg .meta{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--mut);margin-bottom:6px}
.badge{background:var(--owner);color:#1a1206;font-weight:600;border-radius:6px;padding:1px 7px;font-size:11px}
.msg.owner{border-color:var(--owner)}
.body{white-space:pre-wrap;word-break:break-word}.removed{color:var(--mut);font-style:italic}
.kids{margin-left:18px;border-left:2px solid var(--line);padding-left:12px}
button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--card2);color:var(--ink);border-radius:8px;padding:6px 12px}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:#ff8b8b;border-color:#5a2b2b}
.linkbtn{background:none;border:none;color:var(--accent);padding:0;font-size:12px}
textarea{width:100%;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:10px;font:inherit;resize:vertical;min-height:64px}
input[type=text]{background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
.hp{position:absolute;left:-9999px;width:1px;height:1px}
.q{font-size:13px;color:var(--mut)}.err{color:#ff8b8b;font-size:13px}
form{margin:8px 0 0}
`;

// ---------- public page ----------
function renderPublicNode(node) {
  if (node.deleted && !hasVisibleDescendant(node)) return '';
  const bodyHtml = node.deleted ? '<span class="removed">[message removed]</span>'
    : `<div class="body">${esc(node.body)}</div>`;
  const who = node.isOwner ? '<span class="badge">Owner</span>' : 'Anonymous';
  const edited = node.editedAt ? ' · edited' : '';
  const kids = node.children.map(renderPublicNode).join('');
  return `<div class="msg ${node.isOwner ? 'owner' : ''}" data-id="${node.id}">
    <div class="meta">${who}<span>·</span><span>${fmtTime(node.createdAt)}${edited}</span></div>
    ${bodyHtml}
    <div class="row"><button class="linkbtn" onclick="reply('${node.id}',this)">Reply</button></div>
    <div class="kids">${kids}</div>
  </div>`;
}
function publicPage() {
  const tree = buildTree().map(renderPublicNode).join('') || '<p class="sub">No messages yet. Be the first.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Message Board</title>
<style>${STYLE}</style></head><body><div class="wrap">
<h1>Message Board</h1><p class="sub">Leave me a message — anyone can post and reply. Posts are anonymous.</p>
<div class="card" id="composer">
  <form onsubmit="return post(event,null,this)">
    <textarea name="body" maxlength="${MAX_LEN}" placeholder="Write a message…" required></textarea>
    <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
    <div class="row"><span class="q" data-q>…</span><input type="text" name="answer" inputmode="numeric" placeholder="answer" style="width:90px" required>
    <button class="primary" type="submit">Post</button></div>
    <div class="err" data-err></div>
  </form>
</div>
<div id="board">${tree}</div>
</div>
<script>
async function challenge(form){const r=await fetch('api/challenge');const j=await r.json();form.querySelector('[data-q]').textContent=j.question;form.dataset.token=j.token;}
document.querySelectorAll('#composer form').forEach(challenge);
async function post(e,parentId,form){e.preventDefault();const err=form.querySelector('[data-err]');err.textContent='';
 const body=form.body.value.trim();if(!body){return false;}
 const payload={parentId,body,challengeToken:form.dataset.token,challengeAnswer:form.answer.value,website:form.website?form.website.value:''};
 const r=await fetch('api/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
 const j=await r.json();if(!r.ok){err.textContent=j.error||'Failed';await challenge(form);return false;}
 location.reload();return false;}
function reply(id,btn){const host=btn.closest('.msg');if(host.querySelector('.replyform')){host.querySelector('.replyform').remove();return;}
 const f=document.createElement('form');f.className='replyform';f.onsubmit=(e)=>post(e,id,f);
 f.innerHTML='<textarea name="body" maxlength="${MAX_LEN}" placeholder="Reply…" required></textarea>'+
 '<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">'+
 '<div class="row"><span class="q" data-q>…</span><input type="text" name="answer" inputmode="numeric" placeholder="answer" style="width:90px" required>'+
 '<button class="primary" type="submit">Reply</button></div><div class="err" data-err></div>';
 host.querySelector('.row').after(f);challenge(f);}
</script></body></html>`;
}

// ---------- manager page ----------
function renderManageNode(node) {
  const who = node.isOwner ? '<span class="badge">Owner</span>' : 'Anonymous';
  const status = node.deleted ? ' · <span class="removed">deleted</span>' : (node.editedAt ? ' · edited' : '');
  const kids = node.children.map(renderManageNode).join('');
  return `<div class="msg ${node.isOwner ? 'owner' : ''}" data-id="${node.id}">
    <div class="meta">${who}<span>·</span><span>${fmtTime(node.createdAt)}${status}</span></div>
    <div class="body">${esc(node.body)}</div>
    <div class="row">
      <button class="linkbtn" onclick="ownerReply('${node.id}',this)">Reply as owner</button>
      <button class="linkbtn" onclick="edit('${node.id}',this)">Edit</button>
      ${node.deleted ? `<button class="linkbtn" onclick="act('restore','${node.id}')">Restore</button>`
        : `<button class="linkbtn" style="color:#ff8b8b" onclick="if(confirm('Delete this message?'))act('delete','${node.id}')">Delete</button>`}
    </div>
    <div class="kids">${kids}</div>
  </div>`;
}
function managePage() {
  const tree = buildTree().map(renderManageNode).join('') || '<p class="sub">No messages yet.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Message Board · Manager</title>
<style>${STYLE}</style></head><body><div class="wrap">
<h1>Message Board · Manager</h1><p class="sub">Owner-only. Reply as owner, edit, or delete any message. Not published to the web.</p>
<div class="card">
  <form onsubmit="return ownerPost(event,null,this)">
    <textarea name="body" placeholder="Post a new top-level message as owner…" required></textarea>
    <div class="row"><button class="primary" type="submit">Post as owner</button></div>
  </form>
</div>
<div id="board">${tree}</div></div>
<script>
async function api(path,payload){const r=await fetch('/manage/api/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload||{})});if(!r.ok){alert('Failed');return false;}location.reload();return false;}
function act(op,id){return api(op,{id});}
function ownerPost(e,parentId,form){e.preventDefault();const body=form.body.value.trim();if(!body)return false;return api('reply',{parentId,body});}
function ownerReply(id,btn){const host=btn.closest('.msg');if(host.querySelector('.opform')){host.querySelector('.opform').remove();return;}
 const f=document.createElement('form');f.className='opform';f.onsubmit=(e)=>ownerPost(e,id,f);
 f.innerHTML='<textarea name="body" placeholder="Reply as owner…" required></textarea><div class="row"><button class="primary" type="submit">Reply</button></div>';
 host.querySelector('.row').after(f);}
function edit(id,btn){const host=btn.closest('.msg');if(host.querySelector('.edform')){host.querySelector('.edform').remove();return;}
 const cur=host.querySelector('.body').textContent;const f=document.createElement('form');f.className='edform';
 f.onsubmit=(e)=>{e.preventDefault();return api('edit',{id,body:f.body.value});};
 f.innerHTML='<textarea name="body" required></textarea><div class="row"><button class="primary" type="submit">Save</button></div>';
 host.querySelector('.row').after(f);f.body.value=cur;}
</script></body></html>`;
}

// ---------- public server ----------
const publicServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, 200, publicPage());
    if (req.method === 'GET' && url.pathname === '/api/challenge') return sendJson(res, 200, newChallenge());
    if (req.method === 'POST' && url.pathname === '/api/messages') {
      const b = await readBody(req);
      if (b.website) return sendJson(res, 400, { error: 'rejected' }); // honeypot
      const body = (b.body || '').toString().trim();
      if (!body) return sendJson(res, 400, { error: 'Message is empty.' });
      if (body.length > MAX_LEN) return sendJson(res, 400, { error: 'Message too long.' });
      if (!checkChallenge(b.challengeToken, b.challengeAnswer)) return sendJson(res, 400, { error: 'Wrong answer to the challenge.' });
      if (!rateOk(clientIp(req))) return sendJson(res, 429, { error: 'Too many posts, slow down a moment.' });
      if (b.parentId && !findMsg(b.parentId)) return sendJson(res, 400, { error: 'Parent not found.' });
      addMessage({ parentId: b.parentId || null, body, isOwner: false });
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (e) { sendJson(res, 400, { error: 'Bad request' }); }
});

// ---------- manager server (owner only, never published) ----------
const manageServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (url.pathname === '/manage' || url.pathname === '/manage/' || url.pathname === '/')) return sendHtml(res, 200, managePage());
    if (req.method === 'POST' && url.pathname === '/manage/api/reply') {
      const b = await readBody(req); const body = (b.body || '').toString().trim();
      if (!body) return sendJson(res, 400, { error: 'empty' });
      if (b.parentId && !findMsg(b.parentId)) return sendJson(res, 400, { error: 'parent not found' });
      addMessage({ parentId: b.parentId || null, body, isOwner: true });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/manage/api/edit') {
      const b = await readBody(req); const m = findMsg(b.id); if (!m) return sendJson(res, 404, { error: 'not found' });
      m.body = (b.body || '').toString(); m.editedAt = Date.now(); save(); return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/manage/api/delete') {
      const b = await readBody(req); const m = findMsg(b.id); if (!m) return sendJson(res, 404, { error: 'not found' });
      m.deleted = true; save(); return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/manage/api/restore') {
      const b = await readBody(req); const m = findMsg(b.id); if (!m) return sendJson(res, 404, { error: 'not found' });
      m.deleted = false; save(); return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (e) { sendJson(res, 400, { error: 'Bad request' }); }
});

publicServer.listen(PORT, HOST, () => console.log(`[public] http://${HOST}:${PORT}/`));
manageServer.listen(MANAGE_PORT, HOST, () => console.log(`[manage] http://${HOST}:${MANAGE_PORT}/manage`));
