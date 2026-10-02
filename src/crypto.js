// Link format, key derivation and record encryption.
// WebCrypto only, so the same file runs in Node, Cloudflare Workers, Deno, Bun and browsers.
//
//   rw link:  https://relay.example/#rw.<S>            S = 32 random bytes
//   ro link:  https://relay.example/#ro.<K_enc>.<R>
//
//   K_enc = HKDF(S, "contextshare/v1/enc")       AES-256-GCM key, never sent to the relay
//   K_id  = HKDF(K_enc, "contextshare/v1/id")    HMAC key that turns key names into opaque record ids
//   W     = HKDF(S, "contextshare/v1/write")     write token (bearer)
//   R     = SHA-256("contextshare/v1/read"  | W) read token (bearer)
//   space = SHA-256("contextshare/v1/space" | R) space id, public
//
// The relay needs no account table: it hashes whatever bearer token it is shown and checks
// whether the result lands on the space id in the URL. One hash away means read access,
// two hashes away means write access.

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = globalThis.crypto.subtle;

export function toB64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(str) {
  let s;
  try {
    if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new Error();
    s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  } catch { throw new Error('invalid base64url'); }
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(secret, info) {
  const key = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) }, key, 256);
  return new Uint8Array(bits);
}

async function labelledHash(label, bytes) {
  return new Uint8Array(await subtle.digest('SHA-256', concat(te.encode(label + '\0'), bytes)));
}

export const readFromWrite = (w) => labelledHash('contextshare/v1/read', w);
export const spaceFromRead = (r) => labelledHash('contextshare/v1/space', r);

/** What the relay does with a bearer token: returns 'rw', 'ro' or null for the given space id. */
export async function accessFor(space, token) {
  let t;
  try { t = fromB64u(token); } catch { return null; }
  if (t.length !== 32) return null;
  if (toB64u(await spaceFromRead(t)) === space) return 'ro';
  if (toB64u(await spaceFromRead(await readFromWrite(t))) === space) return 'rw';
  return null;
}

export function newSecret() {
  return toB64u(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export function makeLink(relay, secret = newSecret()) {
  return `${relay.replace(/\/+$/, '')}/#rw.${secret}`;
}

/** Parse a share link and derive everything a client needs. */
export async function openLink(link) {
  let u;
  try { u = new URL(link); } catch { throw new Error('not a contextshare link (expected https://relay/#rw.<secret>)'); }
  const [mode, a, b] = u.hash.slice(1).split('.');
  const relay = (u.origin + u.pathname).replace(/\/+$/, '');
  const key = (part) => {
    let bytes;
    try { bytes = fromB64u(part); } catch { bytes = []; }
    if (bytes.length !== 32) throw new Error('the secret in this link is damaged (mistyped or cut short?)');
    return bytes;
  };
  let encRaw, write = null, read;
  if (mode === 'rw' && a && !b) {
    const s = key(a);
    encRaw = await hkdf(s, 'contextshare/v1/enc');
    write = await hkdf(s, 'contextshare/v1/write');
    read = await readFromWrite(write);
  } else if (mode === 'ro' && a && b) {
    encRaw = key(a);
    read = key(b);
  } else {
    throw new Error('not a contextshare link (expected https://relay/#rw.<secret> or #ro.<key>.<token>)');
  }
  const space = toB64u(await spaceFromRead(read));
  const encKey = await subtle.importKey('raw', encRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const idKey = await subtle.importKey('raw', await hkdf(encRaw, 'contextshare/v1/id'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return {
    relay, mode, space, encKey, idKey,
    readToken: toB64u(read),
    writeToken: write ? toB64u(write) : null,
    roLink: `${relay}/#ro.${toB64u(encRaw)}.${toB64u(read)}`,
  };
}

/** Opaque record id for a key name. The relay never sees the name itself. */
export async function recordId(sp, key) {
  const mac = new Uint8Array(await subtle.sign('HMAC', sp.idKey, te.encode(key)));
  return toB64u(mac.slice(0, 16));
}

const aad = (sp, id) => te.encode(`contextshare/v1|${sp.space}|${id}`);

/** Encrypt a JSON-serialisable envelope, bound to this space and record id. */
export async function seal(sp, id, envelope) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(sp, id) },
    sp.encKey, te.encode(JSON.stringify(envelope)));
  return 'v1.' + toB64u(concat(iv, new Uint8Array(ct)));
}

/** Decrypt a blob. Throws if it was tampered with, moved to another id, or made with another key. */
export async function unseal(sp, id, blob) {
  if (typeof blob !== 'string' || !blob.startsWith('v1.')) throw new Error('unknown blob version');
  const raw = fromB64u(blob.slice(3));
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: aad(sp, id) },
    sp.encKey, raw.slice(12));
  return JSON.parse(td.decode(pt));
}
