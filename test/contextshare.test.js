import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeLink, openLink, recordId, seal, unseal, accessFor } from '../src/crypto.js';
import { Space, ConflictError, mergePatch, parseSince, migrate } from '../src/client.js';
import { startRelay } from '../src/relay-node.js';

const BIN = fileURLToPath(new URL('../bin/contextshare.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'contextshare-test-'));
// Set CONTEXTSHARE_TEST_RELAY=http://127.0.0.1:8788 to run the same suite against another relay,
// for example the Cloudflare Worker under `npx wrangler dev`.
const EXTERNAL = process.env.CONTEXTSHARE_TEST_RELAY || null;
let relay;

before(async () => {
  relay = EXTERNAL ? { url: EXTERNAL.replace(/\/+$/, ''), close: async () => {} } : await startRelay({ port: 0, db: join(dir, 'relay.db') });
});
after(async () => { await relay.close(); });

const raw = (space, path, { method = 'GET', token, body, headers = {} } = {}) =>
  fetch(`${relay.url}/v1/${space}/records${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

test('link derivation: read-only link opens the same space but carries no write token', async () => {
  const rw = await openLink(makeLink('https://relay.example/'));
  const ro = await openLink(rw.roLink);
  assert.equal(rw.relay, 'https://relay.example');
  assert.equal(ro.space, rw.space);
  assert.equal(ro.writeToken, null);
  assert.equal(await recordId(ro, 'prospect/acme.com'), await recordId(rw, 'prospect/acme.com'));
  assert.equal(await accessFor(rw.space, rw.writeToken), 'rw');
  assert.equal(await accessFor(rw.space, rw.readToken), 'ro');
  const other = await openLink(makeLink('https://relay.example'));
  assert.equal(await accessFor(rw.space, other.writeToken), null);
  assert.equal(await accessFor(rw.space, 'garbage'), null);
  await assert.rejects(openLink('https://relay.example/#rw.short'), /link is damaged/);
  await assert.rejects(openLink(rw.roLink.slice(0, -3)), /link is damaged/);
  await assert.rejects(openLink('nonsense'), /not a contextshare link/);
});

test('encryption: read-only holder can decrypt; tampering, wrong key and moved blobs fail', async () => {
  const rw = await openLink(makeLink('https://relay.example'));
  const ro = await openLink(rw.roLink);
  const id = await recordId(rw, 'a');
  const blob = await seal(rw, id, { k: 'a', v: { x: 1 } });
  assert.deepEqual(await unseal(ro, id, blob), { k: 'a', v: { x: 1 } });
  assert.notEqual(blob, await seal(rw, id, { k: 'a', v: { x: 1 } }), 'fresh nonce every time');
  const flipped = blob.slice(0, -2) + (blob.endsWith('A') ? 'B' : 'A') + blob.slice(-1);
  await assert.rejects(unseal(rw, id, flipped));
  await assert.rejects(unseal(rw, await recordId(rw, 'b'), blob), 'blob is bound to its record id');
  await assert.rejects(unseal(await openLink(makeLink('https://relay.example')), id, blob));
});

test('merge patch and since parsing', () => {
  assert.deepEqual(mergePatch({ a: 1, b: { c: 2, d: 3 }, e: [1] }, { b: { c: null, x: 9 }, e: [2], f: 'new' }),
    { a: 1, b: { d: 3, x: 9 }, e: [2], f: 'new' });
  assert.deepEqual(mergePatch(undefined, { a: { b: 1 } }), { a: { b: 1 } });
  assert.equal(parseSince(''), null);
  assert.ok(Math.abs(Date.now() - 3 * 86400e3 - parseSince('3d').getTime()) < 1000);
  assert.equal(parseSince('2026-10-01T00:00:00Z').toISOString(), '2026-10-01T00:00:00.000Z');
  assert.throws(() => parseSince('yesterday-ish'), /cannot read/);
});

test('two people share a space: write, read, list, patch, delete', async () => {
  const link = makeLink(relay.url);
  const alice = await Space.open(link, { as: 'alice' });
  const bob = await Space.open(link, { as: 'bob' });

  const w = await alice.put('prospect/acme.com', { stage: 'intro', contact: { name: 'Dana' } });
  assert.equal(w.seq, 1);
  const got = await bob.get('prospect/acme.com');
  assert.deepEqual(got.value, { stage: 'intro', contact: { name: 'Dana' } });
  assert.equal(got.updated_by, 'alice');
  assert.ok(Math.abs(Date.now() - new Date(got.updated_at).getTime()) < 5000, 'updated_at comes from the relay clock');

  await bob.patch('prospect/acme.com', { stage: 'demo booked', notes: ['wants SSO'] });
  const merged = await alice.get('prospect/acme.com');
  assert.deepEqual(merged.value, { stage: 'demo booked', contact: { name: 'Dana' }, notes: ['wants SSO'] });
  assert.equal(merged.updated_by, 'bob');

  await alice.put('prospect/globex.com', [1, 'two', { three: 3 }]);
  await alice.put('note', 'plain string values work too');
  const list = await bob.list();
  assert.deepEqual(list.map((r) => r.key), ['note', 'prospect/globex.com', 'prospect/acme.com']);
  assert.ok(list.every((r) => r.value === undefined && r.updated_at && r.updated_by), 'list returns metadata only');
  assert.deepEqual((await bob.list({ prefix: 'prospect/' })).map((r) => r.key), ['prospect/globex.com', 'prospect/acme.com']);
  assert.equal((await bob.list({ since: new Date(Date.now() + 60e3) })).length, 0);
  assert.equal((await bob.list({ since: '1h' })).length, 3);

  await assert.rejects(bob.patch('prospect/acme.com', 'oops'), /patch must be a JSON object/);
  await assert.rejects(bob.patch('prospect/acme.com', ['oops']), /patch must be a JSON object/);
  await assert.rejects(bob.get(undefined), /key must be a string/);
  await assert.rejects(bob.put('', 1), /key must be a string/);
  assert.deepEqual((await alice.get('prospect/acme.com')).value, merged.value, 'rejected calls changed nothing');

  await bob.delete('note');
  assert.equal(await alice.get('note'), null);
  assert.equal((await alice.list()).length, 2);
  const tomb = (await alice.list({ includeDeleted: true })).find((r) => r.key === 'note');
  assert.equal(tomb.deleted, true);
  assert.equal(tomb.updated_by, 'bob');

  const delta = await alice.changes(w.seq);
  assert.ok(delta.records.length >= 3 && delta.records.every((r) => r.seq > w.seq), 'changes(since) is an incremental cursor');
  assert.equal(await bob.get('never/written'), null);
});

test('optimistic concurrency: stale writes are refused, concurrent patches both land', async () => {
  const link = makeLink(relay.url);
  const alice = await Space.open(link, { as: 'alice' });
  const bob = await Space.open(link, { as: 'bob' });
  const first = await alice.put('k', { n: 1 });
  await bob.put('k', { n: 2 });
  await assert.rejects(alice.put('k', { n: 3 }, { ifSeq: first.seq }), ConflictError);
  await assert.rejects(alice.put('k', { n: 3 }, { ifSeq: 0 }), ConflictError);
  assert.equal((await alice.get('k')).value.n, 2);
  await alice.put('fresh', 1, { ifSeq: 0 });

  await alice.put('shared', {});
  await Promise.all([
    ...Array.from({ length: 5 }, (_, i) => alice.patch('shared', { [`a${i}`]: i }, { retries: 50 })),
    ...Array.from({ length: 5 }, (_, i) => bob.patch('shared', { [`b${i}`]: i }, { retries: 50 })),
  ]);
  assert.equal(Object.keys((await alice.get('shared')).value).length, 10, 'no update was lost');
});

test('read-only link: can read and decrypt, cannot write, and the relay enforces it', async () => {
  const link = makeLink(relay.url);
  const alice = await Space.open(link, { as: 'alice' });
  await alice.put('prospect/acme.com', { stage: 'intro' });
  const carol = await Space.open(alice.readOnlyLink, { as: 'carol' });
  assert.equal(carol.mode, 'ro');
  assert.deepEqual((await carol.get('prospect/acme.com')).value, { stage: 'intro' });
  await assert.rejects(carol.put('x', 1), /read-only link/);

  // A read-only holder has the encryption key, so they can forge a valid blob. The relay must still refuse it.
  const rw = await openLink(link);
  const ro = await openLink(alice.readOnlyLink);
  const id = await recordId(ro, 'prospect/acme.com');
  const forged = await seal(ro, id, { k: 'prospect/acme.com', v: { stage: 'forged' }, by: 'alice' });
  assert.equal((await raw(ro.space, `/${id}`, { method: 'PUT', token: ro.readToken, body: { blob: forged } })).status, 403);
  assert.equal((await raw(ro.space, `/${id}`, { method: 'PUT', body: { blob: forged } })).status, 401);
  assert.equal((await raw(ro.space, '', {})).status, 401);
  const stranger = await openLink(makeLink(relay.url));
  assert.equal((await raw(ro.space, '', { token: stranger.writeToken })).status, 401);
  assert.equal((await raw(ro.space, `/${id}`, { method: 'PUT', token: rw.writeToken, body: { blob: 'plaintext!' } })).status, 400);
  for (const bad of ['"abc"', '-1', '1.5']) {
    assert.equal((await raw(ro.space, `/${id}`, { method: 'PUT', token: rw.writeToken, body: { blob: forged }, headers: { 'if-match': bad } })).status, 400, `If-Match ${JSON.stringify(bad)}`);
  }
  // A blank If-Match must never be read as "0, must not exist" (which would answer 412 here).
  // Node rejects it; the Workers runtime drops blank headers, so there it is an ordinary write.
  for (const blank of ['', ' ']) {
    const status = (await raw(ro.space, `/${id}`, { method: 'PUT', token: rw.writeToken, body: { blob: forged }, headers: { 'if-match': blank } })).status;
    assert.ok(status === 400 || status === 200, `blank If-Match gave ${status}`);
  }
  assert.equal((await raw(ro.space, `/${id}`, { method: 'PUT', token: rw.writeToken, body: { blob: forged } })).status, 200);
  assert.deepEqual((await alice.get('prospect/acme.com')).value, { stage: 'forged' });
});

test('paging: a space with more records than one page lists completely, even while it changes', async () => {
  const link = makeLink(relay.url);
  const s = await Space.open(link, { as: 'alice' });
  for (let i = 0; i < 520; i++) await s.put(`item/${i}`, i);
  const all = await s.list();
  assert.equal(all.length, 520);
  assert.equal(new Set(all.map((r) => r.key)).size, 520);

  // Someone rewrites a record from page one while a reader is between pages.
  let pages = 0;
  const slowReader = await Space.open(link, { as: 'bob', fetch: async (url, init) => {
    const res = await fetch(url, init);
    if (init.method === 'GET' && ++pages === 1) await s.put('item/0', 'rewritten');
    return res;
  } });
  const during = await slowReader.list();
  assert.equal(during.length, 520, 'no key is listed twice');
  assert.equal(during.filter((r) => r.key === 'item/0').length, 1);
  assert.equal(during[0].key, 'item/0', 'and the rewritten record is the newest');
});

test('rotation keeps edits that other people make while it runs', async () => {
  const oldLink = makeLink(relay.url);
  const alice = await Space.open(oldLink, { as: 'alice' });
  const bob = await Space.open(oldLink, { as: 'bob' });
  await alice.put('prospect/acme.com', { stage: 'intro' });
  await alice.put('prospect/doomed.com', { stage: 'dead' });
  await alice.put('prospect/quiet.com', { stage: 'demo' });
  const fresh = await Space.open(makeLink(relay.url), { as: 'alice' });

  const result = await migrate(alice, fresh, { afterFirstCopy: async () => {
    // Everything is copied, nothing is deleted yet. Bob keeps working on the old link.
    await bob.patch('prospect/acme.com', { owner: 'bob' });
    await bob.delete('prospect/doomed.com');
    await bob.put('prospect/late.com', { stage: 'new' });
  } });
  assert.deepEqual(result, { moved: 3, unreadable: 0, remaining: 0 });

  const acme = await fresh.get('prospect/acme.com');
  assert.deepEqual(acme.value, { stage: 'intro', owner: 'bob' }, "bob's edit made it across");
  assert.equal(acme.updated_by, 'bob');
  assert.equal(await fresh.get('prospect/doomed.com'), null, "bob's deletion made it across");
  assert.deepEqual((await fresh.get('prospect/late.com')).value, { stage: 'new' });
  assert.equal((await fresh.get('prospect/quiet.com')).updated_by, 'alice');
  assert.equal((await alice.list()).length, 0, 'the old space is empty');

  // A patch that lands on the old space after it was emptied carries only its own fields. It is merged.
  const srcLink = makeLink(relay.url);
  const src = await Space.open(srcLink, { as: 'alice' });
  const late = await Space.open(srcLink, { as: 'bob' });
  const next = await Space.open(makeLink(relay.url), { as: 'alice' });
  await src.put('k', { a: 1, b: 2 });
  let round = 0;
  const changes = src.changes.bind(src);
  src.changes = async (since) => {
    if (++round === 2) await late.patch('k', { c: 3 }); // round one has already emptied the old space
    return changes(since);
  };
  await migrate(src, next);
  assert.deepEqual((await next.get('k')).value, { a: 1, b: 2, c: 3 });
});

test('browser viewer: the page script decrypts a read-only link the same way the client does', async () => {
  const page = await (await fetch(`${relay.url}/`)).text();
  assert.match(page, /<title>contextshare<\/title>/);
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(page)[1];
  const { loadRecords } = await import('data:text/javascript,' + encodeURIComponent(script));

  const rwLink = makeLink(relay.url);
  const linkOf = async () => rwLink;
  const alice = await Space.open(rwLink, { as: 'alice' });
  await alice.put('_space', { name: 'Demo' });
  await alice.put('calendar/next-week', { events: [{ title: 'Pricing review', start: '2026-10-06T10:00:00+03:00' }] });
  await alice.put('gone', 1);
  await alice.delete('gone');

  const records = await loadRecords(relay.url, new URL(alice.readOnlyLink).hash);
  assert.deepEqual(records.map((r) => r.key), ['calendar/next-week', '_space']);
  assert.equal(records[0].value.events[0].title, 'Pricing review');
  assert.equal(records[0].updated_by, 'alice');
  assert.deepEqual((await loadRecords(relay.url, new URL(await linkOf(alice)).hash)).map((r) => r.key), ['calendar/next-week', '_space'], 'a read-write link opens too');

  await assert.rejects(loadRecords(relay.url, '#nonsense'), /does not look like/);
  // The right read token with the wrong key gets ciphertext it cannot open.
  const [, , token] = new URL(alice.readOnlyLink).hash.split('.');
  const wrongKey = await loadRecords(relay.url, `#ro.${'A'.repeat(43)}.${token}`);
  assert.ok(wrongKey.length > 0 && wrongKey.every((r) => r.key === '(could not decrypt)' && r.value === null));
});

test('the relay database holds no plaintext: no key names, values or author names', { skip: EXTERNAL ? 'inspects the local SQLite file' : false }, async () => {
  const s = await Space.open(makeLink(relay.url), { as: 'zebedee-the-author' });
  await s.put('prospect/very-secret-company.example', { note: 'budget is four hundred thousand', champion: 'Quentin Xavier' });
  const disk = Buffer.concat(readdirSync(dir).filter((f) => f.startsWith('relay.db')).map((f) => readFileSync(join(dir, f)))).toString('latin1');
  assert.ok(disk.includes(s.id), 'sanity check: the space id is on disk');
  for (const secret of ['very-secret-company', 'prospect/', 'four hundred thousand', 'Quentin', 'zebedee', 'budget']) {
    assert.ok(!disk.includes(secret), `found "${secret}" in the relay database`);
  }
});

test('create token: a relay can refuse new spaces from strangers', { skip: EXTERNAL ? 'starts its own relay' : false }, async () => {
  const gated = await startRelay({ port: 0, createToken: 'letmein' });
  try {
    const link = makeLink(gated.url);
    await assert.rejects((await Space.open(link, { as: 'mallory' })).put('a', 1), /create token/);
    await (await Space.open(link, { as: 'alice', createToken: 'letmein' })).put('a', 1);
    const bob = await Space.open(link, { as: 'bob' });
    await bob.put('b', 2); // once the space exists, the link alone is enough
    assert.equal((await bob.list()).length, 2);
  } finally { await gated.close(); }
});

// ---------- CLI and MCP, driven as real subprocesses with separate config files per person ----------

// Async on purpose: the relay runs inside this process, so a blocking child call would deadlock it.
const cli = (who, args, input) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, CONTEXTSHARE_CONFIG: join(dir, `${who}.json`), CONTEXTSHARE_AS: who, CONTEXTSHARE_LINK: '', CONTEXTSHARE_RELAY: relay.url },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
  child.stdin.end(input ?? '');
});

test('CLI: new, share, join, put, patch, get, ls, read-only link, rotate', async () => {
  const out = await cli('alice', ['new', 'prospects', '--relay', relay.url]);
  const link = /^http\S+#rw\.\S+$/m.exec(out)[0];
  assert.match(await cli('bob', ['join', 'prospects', link]), /Joined "prospects" \(read-write/);
  await cli('alice', ['put', 'prospect/acme.com', '{"stage":"intro"}']);
  await cli('bob', ['patch', 'prospect/acme.com', '-'], '{"owner":"bob"}');
  const rec = JSON.parse(await cli('alice', ['get', 'prospect/acme.com']));
  assert.deepEqual(rec.value, { stage: 'intro', owner: 'bob' });
  assert.equal(rec.updated_by, 'bob');
  assert.match(await cli('alice', ['ls', '--prefix', 'prospect/']), /prospect\/acme\.com\s+\d{4}-.*Z\s+bob/);
  assert.equal(statSync(join(dir, 'alice.json')).mode & 0o777, 0o600, 'config file is private');

  await assert.rejects(cli('alice', ['put', 'prospect/acme.com', '{"stage": broken']), /looks like JSON but does not parse/);
  await assert.rejects(cli('alice', ['patch', 'prospect/acme.com', 'just words']), /patch must be a JSON object/);
  assert.deepEqual(JSON.parse(await cli('alice', ['get', 'prospect/acme.com'])).value, rec.value, 'bad input changed nothing');

  const ro = (await cli('alice', ['link', '--ro'])).trim();
  assert.match(await cli('carol', ['join', 'prospects', '-'], ro), /read-only/);
  assert.equal(JSON.parse(await cli('carol', ['get', 'prospect/acme.com'])).value.stage, 'intro');
  await assert.rejects(cli('carol', ['put', 'x', '1']), /read-only link/);

  // Rotation is the revocation story: alice moves to a new link, bob's old link sees an emptied space.
  const beforeRotate = JSON.parse(await cli('alice', ['get', 'prospect/acme.com']));
  const rotated = await cli('alice', ['rotate']);
  const fresh = /^http\S+#rw\.\S+$/m.exec(rotated)[0];
  assert.notEqual(fresh, link);
  const afterRotate = JSON.parse(await cli('alice', ['get', 'prospect/acme.com']));
  assert.equal(afterRotate.updated_by, 'bob', 'authorship survives rotation');
  assert.equal(afterRotate.updated_at, beforeRotate.updated_at, 'so does the last-updated time');
  assert.deepEqual(afterRotate.value, beforeRotate.value);
  assert.match(await cli('bob', ['ls']), /No records/);
  await assert.rejects(cli('bob', ['get', 'prospect/acme.com']), /no record/);
});

test('CLI: the demo flow. Share by link, consume, update, and pick up the change without a new link', async () => {
  // Sender creates a space and writes next week's meetings.
  const made = await cli('sender', ['new', 'dana-meetings']);
  const roLink = /^http\S+#ro\.\S+$/m.exec(made)[0];
  await cli('sender', ['put', 'calendar/next-week', '-'], JSON.stringify({ events: [{ title: 'Pricing review', start: '2026-10-06T10:00:00+03:00' }] }));

  // Receiver joins with the read-only link and pulls.
  assert.match(await cli('receiver', ['join', 'assaf', roLink]), /read-only, 1 records/);
  const first = JSON.parse(await cli('receiver', ['pull']));
  assert.equal(first.first_pull, true);
  assert.equal(first.access, 'read-only');
  assert.deepEqual(first.records.map((r) => r.key), ['calendar/next-week']);
  assert.equal(first.records[0].value.events.length, 1);
  assert.equal(first.records[0].updated_by, 'sender');

  // Nothing changed: the next pull says so.
  const quiet = JSON.parse(await cli('receiver', ['pull']));
  assert.equal(quiet.first_pull, false);
  assert.deepEqual(quiet.changed_since_last_pull, []);
  assert.equal(quiet.records.length, 1);

  // Sender updates the same space: one record changed, one added, one added then removed.
  await cli('sender', ['put', 'calendar/next-week', '-'], JSON.stringify({ events: [
    { title: 'Pricing review', start: '2026-10-06T10:00:00+03:00' },
    { title: 'Lunch with Dana', start: '2026-10-08T12:30:00+03:00' }] }));
  await cli('sender', ['put', 'notes/agenda', '{"topic":"renewal"}']);
  await cli('sender', ['put', 'notes/scrap', '1']);
  await cli('sender', ['rm', 'notes/scrap']);

  // Receiver, same link, picks up exactly what changed.
  const again = JSON.parse(await cli('receiver', ['pull']));
  assert.deepEqual(again.changed_since_last_pull.map((c) => [c.key, c.change]).sort(),
    [['calendar/next-week', 'new or updated'], ['notes/agenda', 'new or updated'], ['notes/scrap', 'deleted']]);
  assert.equal(again.records.find((r) => r.key === 'calendar/next-week').value.events.length, 2);
  assert.deepEqual(again.records.map((r) => r.key).sort(), ['calendar/next-week', 'notes/agenda']);
  const onlyNew = JSON.parse(await cli('receiver', ['pull', '--new']));
  assert.deepEqual(onlyNew.records, []);

  // The guide prints, and setup records the name without touching the real home directory.
  assert.match(await cli('receiver', ['guide']), /The person RECEIVED a link/);
  assert.match(await cli('receiver', ['setup', '--as', 'Dana', '--no-skill']), /written as "receiver"|written as "Dana"/);
});

test('CLI: a broken config file never echoes link material; flags need values', async () => {
  const secret = 'SUPERSECRETLINKMATERIAL0123456789abcdefghij';
  writeFileSync(join(dir, 'mallory.json'), `{"spaces":{"w":https://r.example/#rw.${secret}}}`);
  const err = await cli('mallory', ['ls']).then(() => null, (e) => e.message);
  assert.match(err, /not valid JSON/);
  for (let i = 0; i + 6 <= secret.length; i++) assert.ok(!err.includes(secret.slice(i, i + 6)), 'no fragment of the secret in the error');
  await assert.rejects(cli('alice', ['ls', '-s']), /-s needs a value/);
  await assert.rejects(cli('alice', ['ls', '--since', '--json']), /--since needs a value/);
});

function mcpSession(who) {
  const child = spawn(process.execPath, [BIN, 'mcp'], {
    env: { ...process.env, CONTEXTSHARE_CONFIG: join(dir, `${who}.json`), CONTEXTSHARE_AS: who, CONTEXTSHARE_LINK: '' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  // If the server dies, fail the pending calls instead of hanging the suite.
  child.on('exit', () => { for (const [, reject] of failing) reject(new Error('MCP server exited')); });
  const failing = new Map();
  let next = 1;
  return {
    send: (method, params) => new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, (msg) => { failing.delete(id); resolve(msg); });
      failing.set(id, reject);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
    }),
    notify: (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'),
    close: () => new Promise((resolve) => { child.on('exit', resolve); child.stdin.end(); }),
  };
}

test('MCP over stdio: legacy handshake, tools, and a cross-person round trip', async () => {
  const out = await cli('dave', ['new', 'deals', '--relay', relay.url]);
  await cli('erin', ['join', 'deals', /^http\S+#rw\.\S+$/m.exec(out)[0]]);
  const dave = mcpSession('dave'), erin = mcpSession('erin');
  try {
    const init = await dave.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(init.result.resultType, undefined, 'legacy results carry no resultType');
    assert.equal((await dave.send('tools/list')).result.ttlMs, undefined, 'and no caching hints');
    dave.notify('notifications/initialized');
    assert.deepEqual((await dave.send('ping')).result, {});
    assert.equal((await dave.send('initialize', { protocolVersion: '2099-01-01' })).result.protocolVersion, '2025-11-25');

    const tools = (await dave.send('tools/list')).result.tools;
    assert.deepEqual(tools.map((t) => t.name), ['shared_spaces', 'shared_list', 'shared_get', 'shared_put', 'shared_patch', 'shared_delete']);
    assert.ok(tools.every((t) => t.inputSchema.type === 'object' && t.description));

    const call = async (s, name, args) => (await s.send('tools/call', { name, arguments: args })).result;
    const put = await call(dave, 'shared_put', { key: 'prospect/initech.com', value: { stage: 'intro', arr: 120000 } });
    assert.equal(put.isError, false);
    await call(erin, 'shared_patch', { key: 'prospect/initech.com', patch: { next_step: 'send pricing' } });

    const got = await call(dave, 'shared_get', { key: 'prospect/initech.com' });
    assert.deepEqual(got.structuredContent.value, { stage: 'intro', arr: 120000, next_step: 'send pricing' });
    assert.equal(got.structuredContent.updated_by, 'erin');
    assert.deepEqual(JSON.parse(got.content[0].text), got.structuredContent);

    const list = await call(erin, 'shared_list', { since: '1h', prefix: 'prospect/' });
    assert.equal(list.structuredContent.count, 1);
    assert.equal(list.structuredContent.records[0].value, undefined);

    const spaces = await call(erin, 'shared_spaces', {});
    assert.deepEqual(spaces.structuredContent, { writing_as: 'erin', spaces: [{ name: 'deals', access: 'read-write', relay: relay.url }] });
    assert.ok(!JSON.stringify(spaces).includes('#rw.'), 'the share link never reaches the model');

    assert.equal((await call(dave, 'shared_get', { key: 'nope' })).structuredContent.found, false);
    const stale = await call(dave, 'shared_put', { key: 'prospect/initech.com', value: {}, if_seq: 1 });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /changed since it was read/);
    assert.equal((await call(dave, 'shared_get', { space: 'missing', key: 'x' })).isError, true);
    assert.equal((await dave.send('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
    assert.equal((await dave.send('resources/list')).error.code, -32601);

    // A broken config must not leak into the model's context either.
    const broken = mcpSession('mallory');
    try {
      const res = (await broken.send('tools/call', { name: 'shared_list', arguments: {} })).result;
      assert.equal(res.isError, true);
      assert.ok(!res.content[0].text.includes('SUPERSECRET') && !res.content[0].text.includes('r.example'));
    } finally { await broken.close(); }
  } finally { await dave.close(); await erin.close(); }
});

test('MCP over stdio: 2026-07-28 stateless protocol', async () => {
  const s = mcpSession('dave');
  const meta = (v = '2026-07-28') => ({ _meta: {
    'io.modelcontextprotocol/protocolVersion': v,
    'io.modelcontextprotocol/clientInfo': { name: 't', version: '0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  } });
  try {
    const d = (await s.send('server/discover', meta())).result;
    assert.equal(d.resultType, 'complete');
    assert.ok(d.supportedVersions.includes('2026-07-28') && d.supportedVersions.includes('2025-11-25'));
    assert.deepEqual(d.capabilities, { tools: {} });
    assert.equal(d._meta['io.modelcontextprotocol/serverInfo'].name, 'contextshare');

    const bad = (await s.send('tools/list', meta('2031-01-01'))).error;
    assert.equal(bad.code, -32022);
    assert.equal(bad.data.requested, '2031-01-01');
    assert.ok(bad.data.supported.includes('2026-07-28'));

    const listed = (await s.send('tools/list', meta())).result;
    assert.equal(listed.resultType, 'complete');
    for (const r of [d, listed]) { // caching hints are mandatory on these two in the modern protocol
      assert.ok(Number.isInteger(r.ttlMs) && r.ttlMs >= 0);
      assert.equal(r.cacheScope, 'public');
    }
    const got = (await s.send('tools/call', { name: 'shared_get', arguments: { key: 'prospect/initech.com' }, ...meta() })).result;
    assert.equal(got.resultType, 'complete');
    assert.equal(got.structuredContent.value.next_step, 'send pricing');
  } finally { await s.close(); }
});
