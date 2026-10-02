// Self-hosted relay: one Node process, one SQLite file, no dependencies.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createRelay, SCHEMA } from './relay-core.js';

export function startRelay({ port = 8787, host = '127.0.0.1', db = ':memory:', createToken = null, now } = {}) {
  const database = new DatabaseSync(db);
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec(SCHEMA);
  const statements = new Map();
  const exec = (sql, ...params) => {
    let st = statements.get(sql);
    if (!st) statements.set(sql, st = database.prepare(sql));
    return st.all(...params);
  };
  const handle = createRelay({ exec, createToken, ...(now ? { now } : {}) });

  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 1024 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(c);
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const response = await handle(new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'internal error' }));
      console.error(err);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        url: `http://${host}:${address.port}`,
        port: address.port,
        close: () => new Promise((done) => { server.close(() => { database.close(); done(); }); server.closeAllConnections(); }),
      });
    });
  });
}
