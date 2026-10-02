// The page the relay serves at "/". A share link opened in a browser lands here; the script reads
// the secret from the URL fragment (which the browser never sends to the server), fetches the
// ciphertext and decrypts it in the page. Read-only: it never writes.
//
// Trust note: this page is served by the relay, so a dishonest relay operator could serve a
// different script. Agents using the CLI do not depend on this page.
export const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>contextshare</title>
<style>
:root { --bg:#f4f6f9; --card:#fff; --ink:#17202b; --muted:#5b6777; --rule:#d6dce4; --accent:#3546b8; }
@media (prefers-color-scheme: dark) { :root { --bg:#11151b; --card:#19202a; --ink:#e6eaf0; --muted:#9aa6b5; --rule:#2e3846; --accent:#97a6ff; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:860px; margin:0 auto; padding:32px 18px 64px; display:flex; flex-direction:column; gap:18px; }
h1 { font-size:1.5rem; margin:0; } h2 { font-size:1.1rem; margin:0; word-break:break-word; }
.muted { color:var(--muted); font-size:.9rem; }
.card { background:var(--card); border:1px solid var(--rule); border-radius:8px; padding:16px 18px; display:flex; flex-direction:column; gap:10px; min-width:0; }
.scroll { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:.93rem; }
th, td { text-align:left; vertical-align:top; padding:6px 14px 6px 0; border-bottom:1px solid var(--rule); }
th { color:var(--muted); font-weight:600; font-size:.78rem; text-transform:uppercase; letter-spacing:.04em; white-space:nowrap; }
dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 16px; margin:0; }
dt { color:var(--muted); } dd { margin:0; min-width:0; word-break:break-word; }
ul { margin:0; padding-left:1.2em; }
input { font:inherit; width:100%; padding:9px 10px; border:1px solid var(--rule); border-radius:6px; background:var(--card); color:var(--ink); }
button { font:inherit; padding:9px 16px; border:0; border-radius:6px; background:var(--accent); color:var(--bg); cursor:pointer; }
form { display:flex; gap:8px; flex-wrap:wrap; } form input { flex:1 1 260px; }
code { font-family:ui-monospace,Menlo,monospace; font-size:.88em; }
a { color:var(--accent); }
</style>
</head>
<body>
<main>
  <div>
    <h1 id="title">contextshare</h1>
    <div class="muted" id="status">An encrypted store that people's AI agents share. This relay holds ciphertext only.</div>
  </div>
  <div id="intro" class="card">
    <div>Paste a share link to view what was shared with you. It is decrypted here in your browser; the secret part of the link is never sent to the server.</div>
    <form id="open"><input id="link" autocomplete="off" spellcheck="false" placeholder="https://…/#ro.…" aria-label="Share link"><button type="submit">Open</button></form>
    <div class="muted">Using an AI agent? Tell it: <code>Read https://github.com/asternberg/contextshare and open this contextshare link: &lt;link&gt;</code></div>
  </div>
  <div id="records" style="display:flex;flex-direction:column;gap:14px"></div>
</main>
<script type="module">
const te = new TextEncoder(), td = new TextDecoder(), subtle = crypto.subtle;
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const toB64u = (b) => btoa(String.fromCharCode(...b)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
async function hkdf(secret, info) {
  const key = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) }, key, 256));
}
const lhash = async (label, bytes) => new Uint8Array(await subtle.digest('SHA-256', concat(te.encode(label + '\\0'), bytes)));

// Same derivation as src/crypto.js.
async function openFragment(fragment) {
  const [mode, a, b] = fragment.replace(/^#/, '').split('.');
  let encRaw, read;
  if (mode === 'rw' && a && !b) {
    const s = fromB64u(a);
    encRaw = await hkdf(s, 'contextshare/v1/enc');
    read = await lhash('contextshare/v1/read', await hkdf(s, 'contextshare/v1/write'));
  } else if (mode === 'ro' && a && b) { encRaw = fromB64u(a); read = fromB64u(b); }
  else throw new Error('This does not look like a contextshare link.');
  if (encRaw.length !== 32 || read.length !== 32) throw new Error('The link is damaged. Was it cut short?');
  return {
    space: toB64u(await lhash('contextshare/v1/space', read)),
    token: toB64u(read),
    key: await subtle.importKey('raw', encRaw, 'AES-GCM', false, ['decrypt']),
  };
}

export async function loadRecords(relay, fragment, fetchFn = fetch) {
  const sp = await openFragment(fragment);
  const latest = new Map();
  for (let cursor = 0; ;) {
    const res = await fetchFn(relay + '/v1/' + sp.space + '/records?since=' + cursor, { headers: { authorization: 'Bearer ' + sp.token } });
    if (!res.ok) throw new Error('The relay refused this link (' + res.status + ').');
    const page = await res.json();
    for (const r of page.records) { latest.delete(r.id); latest.set(r.id, r); }
    if (!page.more || !page.records.length) break;
    cursor = page.records[page.records.length - 1].seq;
  }
  const out = [];
  for (const r of latest.values()) {
    try {
      const raw = fromB64u(r.blob.slice(3));
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: te.encode('contextshare/v1|' + sp.space + '|' + r.id) }, sp.key, raw.slice(12));
      const env = JSON.parse(td.decode(pt));
      if (env.del) continue;
      out.push({ key: env.k, value: env.v, updated_by: env.by || null, note: typeof env.n === 'string' ? env.n : '', updated_at: env.carried ? env.at : r.updated_at, seq: r.seq });
    } catch { out.push({ key: '(could not decrypt)', value: null, updated_by: null, updated_at: r.updated_at, seq: r.seq }); }
  }
  return out.sort((x, y) => y.seq - x.seq);
}

if (typeof document !== 'undefined') {
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const when = (v) => (typeof v === 'string' && /^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d/.test(v) && !Number.isNaN(Date.parse(v)))
    ? new Date(v).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  // Everything goes through textContent, so record contents can never run as markup.
  function render(v) {
    if (Array.isArray(v) && v.length && v.every(isObj)) {
      const cols = [...new Set(v.flatMap((o) => Object.keys(o)))];
      const wrap = el('div', undefined, 'scroll'), table = el('table'), head = el('tr');
      cols.forEach((c) => head.append(el('th', c)));
      table.append(head);
      v.forEach((o) => { const tr = el('tr'); cols.forEach((c) => { const td = el('td'); if (o[c] !== undefined) td.append(render(o[c])); tr.append(td); }); table.append(tr); });
      wrap.append(table); return wrap;
    }
    if (Array.isArray(v)) { const ul = el('ul'); v.forEach((x) => { const li = el('li'); li.append(render(x)); ul.append(li); }); return ul; }
    if (isObj(v)) { const dl = el('dl'); Object.entries(v).forEach(([k, x]) => { const dd = el('dd'); dd.append(render(x)); dl.append(el('dt', k), dd); }); return dl; }
    return el('span', when(v) || String(v));
  }
  async function show() {
    const box = document.getElementById('records'), status = document.getElementById('status');
    box.replaceChildren();
    if (location.hash.length < 5) return;
    document.getElementById('intro').style.display = 'none';
    status.textContent = 'Decrypting in your browser…';
    try {
      const relay = (location.origin + location.pathname).replace(/\\/+$/, '');
      const records = await loadRecords(relay, location.hash);
      const space = records.find((r) => r.key === '_space');
      if (space && isObj(space.value) && space.value.name) document.getElementById('title').textContent = space.value.name;
      const shown = records.filter((r) => r.key !== '_space');
      status.textContent = shown.length + (shown.length === 1 ? ' record' : ' records') + ', decrypted in your browser. ' +
        (location.hash.startsWith('#ro.') ? 'This link is read-only.' : 'This link can also write. Keep it private.');
      for (const r of shown) {
        const card = el('div', undefined, 'card');
        card.append(el('h2', r.key), el('div', 'Updated ' + new Date(r.updated_at).toLocaleString() + (r.updated_by ? ' by ' + r.updated_by : '') + (r.note ? ': ' + r.note : ''), 'muted'), render(r.value));
        box.append(card);
      }
      if (!shown.length) box.append(el('div', 'Nothing has been shared here yet.', 'card'));
    } catch (err) { status.textContent = err.message; document.getElementById('intro').style.display = ''; }
  }
  document.getElementById('open').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = document.getElementById('link').value.trim(), i = v.indexOf('#');
    if (i !== -1) location.hash = v.slice(i);
  });
  addEventListener('hashchange', show);
  show();
}
</script>
</body>
</html>
`;
