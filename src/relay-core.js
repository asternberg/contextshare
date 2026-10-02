// The relay: a ciphertext key-value store with a per-space sequence counter.
// It never sees key names, values or author names. Storage is anything that can run SQLite
// through a synchronous `exec(sql, ...params) -> rows[]` function, which covers node:sqlite
// and Cloudflare Durable Object storage with one code path.
import { accessFor } from './crypto.js';
import { VIEWER_HTML } from './viewer.js';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  space TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  blob TEXT NOT NULL,
  PRIMARY KEY (space, id)
);
CREATE INDEX IF NOT EXISTS records_by_seq ON records (space, seq);
`;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, if-match, x-contextshare-create',
  'access-control-expose-headers': 'etag',
};

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...headers },
});

const SPACE_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const BLOB_RE = /^v1\.[A-Za-z0-9_-]+$/;
const PAGE = 500;

const present = (r) => ({ id: r.id, seq: r.seq, updated_at: new Date(r.updated_at).toISOString(), blob: r.blob });

/**
 * @param {object} o
 * @param {(sql: string, ...params: any[]) => any[]} o.exec  synchronous SQLite runner
 * @param {() => number} [o.now]            clock, ms since epoch
 * @param {string|null} [o.createToken]     if set, the first write to a new space must present it
 * @param {number} [o.maxBlob]              max ciphertext size in characters
 * @param {number} [o.maxRecords]           max records per space
 */
export function createRelay({ exec, now = Date.now, createToken = null, maxBlob = 512 * 1024, maxRecords = 10000 }) {
  const maxSeq = (space) => exec('SELECT COALESCE(MAX(seq), 0) AS seq FROM records WHERE space = ?', space)[0].seq;

  // Everything between the first read and the write runs with no await, so it is atomic in
  // both Node (single thread) and Durable Objects (single thread per object).
  function write(space, id, blob, ifMatch, create) {
    const cur = exec('SELECT seq FROM records WHERE space = ? AND id = ?', space, id)[0];
    if (ifMatch !== null && ifMatch !== (cur ? cur.seq : 0)) {
      const full = cur ? exec('SELECT id, seq, updated_at, blob FROM records WHERE space = ? AND id = ?', space, id)[0] : null;
      return json(412, { error: 'conflict', current: full ? present(full) : null });
    }
    if (!cur) {
      const count = exec('SELECT COUNT(*) AS n FROM records WHERE space = ?', space)[0].n;
      if (count === 0 && createToken && create !== createToken) {
        return json(403, { error: 'this relay requires a create token to start a new space' });
      }
      if (count >= maxRecords) return json(507, { error: 'space is full' });
    }
    const seq = maxSeq(space) + 1;
    const ts = now();
    exec(`INSERT INTO records (space, id, seq, updated_at, blob) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (space, id) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at, blob = excluded.blob`,
      space, id, seq, ts, blob);
    return json(200, { id, seq, updated_at: new Date(ts).toISOString() }, { etag: `"${seq}"` });
  }

  return async function handle(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const at = url.pathname.indexOf('/v1/');
    if (at === -1) {
      // The viewer page: a share link opened in a browser decrypts and displays itself here.
      return new Response(VIEWER_HTML, { status: 200, headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ...CORS,
      } });
    }
    const [space, kind, id, extra] = url.pathname.slice(at + 4).split('/');
    if (!SPACE_RE.test(space || '') || kind !== 'records' || extra !== undefined) return json(404, { error: 'not found' });

    const bearer = /^Bearer (\S+)$/.exec(request.headers.get('authorization') || '');
    const access = bearer ? await accessFor(space, bearer[1]) : null;
    if (!access) return json(401, { error: 'missing or wrong token for this space' });

    if (request.method === 'GET' && !id) {
      const since = Number(url.searchParams.get('since') || 0);
      if (!Number.isInteger(since) || since < 0) return json(400, { error: 'since must be a non-negative integer' });
      const rows = exec('SELECT id, seq, updated_at, blob FROM records WHERE space = ? AND seq > ? ORDER BY seq LIMIT ?',
        space, since, PAGE + 1);
      const more = rows.length > PAGE;
      return json(200, { seq: maxSeq(space), more, records: rows.slice(0, PAGE).map(present) });
    }

    if (!ID_RE.test(id || '')) return json(404, { error: 'not found' });

    if (request.method === 'GET') {
      const row = exec('SELECT id, seq, updated_at, blob FROM records WHERE space = ? AND id = ?', space, id)[0];
      return row ? json(200, present(row), { etag: `"${row.seq}"` }) : json(404, { error: 'no such record' });
    }

    if (request.method === 'PUT') {
      if (access !== 'rw') return json(403, { error: 'read-only token' });
      let body;
      try { body = await request.json(); } catch { return json(400, { error: 'body must be JSON' }); }
      const blob = body && body.blob;
      if (typeof blob !== 'string' || !BLOB_RE.test(blob)) return json(400, { error: 'blob must be a v1 ciphertext string' });
      if (blob.length > maxBlob) return json(413, { error: `blob larger than ${maxBlob} characters` });
      let ifMatch = null;
      const h = request.headers.get('if-match');
      if (h !== null) {
        const m = /^\s*"?(\d{1,15})"?\s*$/.exec(h);
        if (!m) return json(400, { error: 'if-match must be a sequence number' });
        ifMatch = Number(m[1]);
      }
      return write(space, id, blob, ifMatch, request.headers.get('x-contextshare-create'));
    }

    return json(405, { error: 'method not allowed' });
  };
}
