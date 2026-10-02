// Hosted relay: Cloudflare Worker + one SQLite-backed Durable Object per space.
// Deploy with `npx wrangler deploy`. There is nothing to provision by hand.
import { DurableObject } from 'cloudflare:workers';
import { createRelay, SCHEMA } from './relay-core.js';
import { accessFor } from './crypto.js';

export class Space extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    for (const statement of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) sql.exec(statement);
    this.handle = createRelay({
      exec: (query, ...params) => sql.exec(query, ...params).toArray(),
      createToken: env.CREATE_TOKEN || null,
    });
  }

  fetch(request) {
    return this.handle(request);
  }
}

// A relay with no storage: it can only produce the landing page, CORS replies, 404s and 401s.
const passthrough = createRelay({ exec: () => [{ seq: 0, n: 0 }] });

export default {
  async fetch(request, env) {
    const match = /\/v1\/([A-Za-z0-9_-]{43})\//.exec(new URL(request.url).pathname);
    // Anything that is not addressed to a space (landing page, CORS preflight, bad paths)
    // is answered here without waking a Durable Object.
    if (!match || request.method === 'OPTIONS') return passthrough(request);
    // Check the token here too, so strangers cannot create or wake objects by guessing space ids.
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get('authorization') || '');
    if (!bearer || !(await accessFor(match[1], bearer[1]))) return passthrough(request);
    return env.SPACE.get(env.SPACE.idFromName(match[1])).fetch(request);
  },
};
