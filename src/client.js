// Client for one space. All encryption and decryption happens here; the relay only moves ciphertext.
import { openLink, recordId, seal, unseal } from './crypto.js';

export class ConflictError extends Error {
  constructor(message, current) { super(message); this.name = 'ConflictError'; this.current = current; }
}

/** RFC 7386 JSON merge patch: objects merge recursively, null removes a field, anything else replaces. */
export function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = target !== null && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

/** Accepts a Date, an ISO timestamp, or a relative age such as "30m", "12h", "3d", "2w". Returns a Date or null. */
export function parseSince(since) {
  if (since === undefined || since === null || since === '') return null;
  if (since instanceof Date) return since;
  const rel = /^(\d+)\s*([mhdw])$/.exec(String(since).trim());
  if (rel) return new Date(Date.now() - Number(rel[1]) * { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[rel[2]]);
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) throw new Error(`cannot read "${since}" as a time; use an ISO date or an age like 3d`);
  return d;
}

function checkKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 512) throw new Error('key must be a string of 1 to 512 characters');
}

// A short human-readable line saying what this write changed. Travels encrypted with the record.
function noteField(note) {
  if (note === undefined || note === null || note === '') return {};
  if (typeof note !== 'string' || note.length > 500) throw new Error('note must be a string of at most 500 characters');
  return { n: note };
}

const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export class Space {
  #sp; #as; #fetch; #createToken;

  constructor(sp, { as = 'unknown', fetch = globalThis.fetch, createToken = null } = {}) {
    this.#sp = sp; this.#as = as; this.#fetch = fetch; this.#createToken = createToken;
  }

  static async open(link, opts) { return new Space(await openLink(link), opts); }

  get mode() { return this.#sp.mode; }
  get relay() { return this.#sp.relay; }
  get id() { return this.#sp.space; }
  /** A link that can read and decrypt but that the relay will refuse writes from. */
  get readOnlyLink() { return this.#sp.roLink; }

  async #request(method, path, { blob, ifSeq } = {}) {
    const write = method !== 'GET';
    if (write && !this.#sp.writeToken) throw new Error('this is a read-only link; ask the owner for a read-write link');
    const headers = { authorization: `Bearer ${write ? this.#sp.writeToken : this.#sp.readToken}` };
    if (blob !== undefined) headers['content-type'] = 'application/json';
    if (ifSeq !== undefined && ifSeq !== null) headers['if-match'] = `"${ifSeq}"`;
    if (write && this.#createToken) headers['x-contextshare-create'] = this.#createToken;
    let res;
    try {
      res = await this.#fetch(`${this.#sp.relay}/v1/${this.#sp.space}/records${path}`,
        { method, headers, body: blob !== undefined ? JSON.stringify({ blob }) : undefined });
    } catch (err) {
      throw new Error(`cannot reach relay ${this.#sp.relay}: ${err.cause?.code || err.message}`);
    }
    if (res.status === 404 && method === 'GET') return null;
    const body = await res.json().catch(() => ({}));
    if (res.status === 412) throw new ConflictError('record changed since it was read', body.current);
    if (!res.ok) throw new Error(`relay said ${res.status}: ${body.error || 'unknown error'}`);
    return body;
  }

  async #decode(rec) {
    try {
      const env = await unseal(this.#sp, rec.id, rec.blob);
      if (await recordId(this.#sp, env.k) !== rec.id) throw new Error('key name does not match record id');
      return {
        key: env.k,
        value: env.del ? undefined : env.v,
        deleted: Boolean(env.del),
        // The relay's clock, except for records carried into a fresh space by `rotate`,
        // which keep the time of their last real edit (as recorded by whoever rotated).
        updated_at: env.carried ? env.at : rec.updated_at,
        updated_by: env.by ?? null,          // self-declared by the writer
        ...(typeof env.n === 'string' && env.n ? { note: env.n } : {}),   // the writer's one-line "what changed"
        seq: rec.seq,
        ...(env.carried ? { carried: true } : {}),
      };
    } catch (err) {
      return { id: rec.id, error: `cannot decrypt (${err.message})`, updated_at: rec.updated_at, seq: rec.seq };
    }
  }

  /** Everything written after sequence number `since`, including deletions. `seq` is the cursor for next time. */
  async changes(since = 0) {
    // A record rewritten while we page shows up again at its new seq. Keep only the latest per id.
    const latest = new Map();
    let cursor = since, head = since;
    for (;;) {
      const page = await this.#request('GET', `?since=${cursor}`);
      head = page.seq;
      for (const rec of page.records) { latest.delete(rec.id); latest.set(rec.id, rec); }
      if (!page.more || page.records.length === 0) break;
      cursor = page.records[page.records.length - 1].seq;
    }
    const records = [];
    for (const rec of latest.values()) records.push(await this.#decode(rec));
    return { seq: head, records };
  }

  /** Metadata for live records, newest first. No values, so it is cheap to put in a model's context. */
  async list({ since, prefix, includeDeleted = false } = {}) {
    const after = parseSince(since);
    const { records } = await this.changes(0);
    return records
      .filter((r) => r.error || includeDeleted || !r.deleted)
      .filter((r) => r.error || !prefix || r.key.startsWith(prefix))
      .filter((r) => !after || new Date(r.updated_at) > after)
      .sort((a, b) => b.seq - a.seq)
      .map((r) => (r.error ? r : {
        key: r.key, updated_at: r.updated_at, updated_by: r.updated_by, ...(r.note ? { note: r.note } : {}), seq: r.seq,
        ...(r.deleted ? { deleted: true } : { bytes: JSON.stringify(r.value).length }),
      }));
  }

  async #read(key) {
    checkKey(key);
    const id = await recordId(this.#sp, key);
    const rec = await this.#request('GET', `/${id}`);
    if (!rec) return null;
    const out = await this.#decode(rec);
    if (out.error) throw new Error(`record "${key}": ${out.error}`);
    return out;
  }

  /** One record with its value, or null if it does not exist or was deleted. */
  async get(key) {
    const rec = await this.#read(key);
    return rec && !rec.deleted ? rec : null;
  }

  async #write(key, envelope, ifSeq) {
    checkKey(key);
    const id = await recordId(this.#sp, key);
    const env = { k: key, by: this.#as, at: new Date().toISOString(), ...envelope };
    const res = await this.#request('PUT', `/${id}`, { blob: await seal(this.#sp, id, env), ifSeq });
    return { key, updated_at: res.updated_at, updated_by: env.by, seq: res.seq };
  }

  /** Replace a record. Pass `ifSeq` (the seq you last read, or 0 for "must not exist") to refuse lost updates. */
  async put(key, value, { ifSeq, note } = {}) {
    if (value === undefined) throw new Error('value is required');
    return this.#write(key, { v: value, ...noteField(note) }, ifSeq);
  }

  /** Copy a record in from another space, keeping who last edited it and when. Used by `rotate`. */
  async carry(record) {
    return this.#write(record.key, { v: record.value, by: record.updated_by, at: record.updated_at, carried: true, ...noteField(record.note) });
  }

  /** Read, merge (RFC 7386) and write back, retrying if someone else wrote in between. */
  async patch(key, patch, { retries = 5, note } = {}) {
    // A merge patch that is not an object would replace the whole record. That is what put is for.
    if (!isPlainObject(patch)) throw new Error('patch must be a JSON object of fields to set or remove; use put to replace a record');
    for (let attempt = 0; ; attempt++) {
      const cur = await this.#read(key);
      const base = cur && !cur.deleted ? cur.value : undefined;
      try {
        return await this.#write(key, { v: mergePatch(base, patch), ...noteField(note) }, cur ? cur.seq : 0);
      } catch (err) {
        if (!(err instanceof ConflictError) || attempt >= retries) throw err;
      }
    }
  }

  /** Overwrite the record with an encrypted tombstone. The old ciphertext is gone from the relay. */
  async delete(key, { ifSeq, note } = {}) {
    return this.#write(key, { del: true, ...noteField(note) }, ifSeq);
  }
}

/**
 * Move every live record from `old` to `fresh` and leave tombstones behind, without losing edits
 * that other people make to `old` while this runs. Deletes are conditional on the version that was
 * copied; anything that changed in the meantime is picked up on the next round.
 * `afterFirstCopy` runs once everything seen in the first pass is safely in `fresh`.
 */
export async function migrate(old, fresh, { afterFirstCopy = async () => {}, rounds = 6 } = {}) {
  const mine = new Map();      // key -> seq of the tombstone this run wrote
  const moved = new Set();
  let cursor = 0, unreadable = 0, remaining = 0;
  for (let round = 0; round < rounds; round++) {
    const { seq, records } = await old.changes(cursor);
    if (round === 0) unreadable = records.filter((r) => r.error).length;
    const live = records.filter((r) => !r.error && !r.deleted);
    // Someone deleted a record in the old space after we copied it: delete our copy too.
    const deletedByOthers = records.filter((r) => !r.error && r.deleted && moved.has(r.key) && !mine.has(r.key));
    for (const r of live) {
      // A write that lands on a key we already emptied was made without seeing the full record
      // (a patch on a tombstone holds only the new fields), so merge it instead of replacing.
      if (mine.has(r.key) && isPlainObject(r.value)) await fresh.patch(r.key, r.value);
      else await fresh.carry(r);
      moved.add(r.key);
    }
    for (const r of deletedByOthers) { await fresh.delete(r.key); moved.delete(r.key); }
    if (round === 0) await afterFirstCopy();
    remaining = 0;
    for (const r of live) {
      try { mine.set(r.key, (await old.delete(r.key, { ifSeq: r.seq })).seq); }
      catch (err) { if (!(err instanceof ConflictError)) throw err; remaining++; }
    }
    cursor = seq;
    if (live.length === 0 && deletedByOthers.length === 0) break;
  }
  return { moved: moved.size, unreadable, remaining };
}
