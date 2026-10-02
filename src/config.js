// Local configuration: the share links live here and nowhere else.
// The MCP server and CLI read this file, so the model only ever handles space *names*.
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { Space } from './client.js';

// The public relay run by the project. It only ever holds ciphertext. Override with --relay or
// CONTEXTSHARE_RELAY to use your own (see README, "Run your own relay").
export const DEFAULT_RELAY = 'https://contextshare-relay.assaf-80e.workers.dev';

export const configPath = () => process.env.CONTEXTSHARE_CONFIG || join(homedir(), '.config', 'contextshare', 'config.json');

export function loadConfig() {
  let cfg = {};
  let text = null;
  try { text = readFileSync(configPath(), 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (text !== null) {
    // Deliberately no detail: the parser's own message quotes the file, which holds the share links.
    try { cfg = JSON.parse(text); } catch { throw new Error(`the config file ${configPath()} is not valid JSON`); }
    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`the config file ${configPath()} is not a JSON object`);
  }
  return { as: cfg.as || null, spaces: cfg.spaces || {} };
}

export function saveConfig(cfg) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function author(cfg = loadConfig()) {
  return process.env.CONTEXTSHARE_AS || cfg.as || userInfo().username;
}

/** Links by name. CONTEXTSHARE_LINK adds a space called "default" without touching the config file. */
export function spaceLinks(cfg = loadConfig()) {
  const links = { ...cfg.spaces };
  if (process.env.CONTEXTSHARE_LINK) links.default = process.env.CONTEXTSHARE_LINK;
  return links;
}

export async function openSpace(name, opts = {}) {
  const cfg = loadConfig();
  const links = spaceLinks(cfg);
  const names = Object.keys(links);
  if (!name) {
    if (names.length === 1) name = names[0];
    else if (links.default) name = 'default';
    else if (names.length === 0) throw new Error('no spaces yet; run `contextshare new <name> --relay <url>` or `contextshare join <name> <link>`');
    else throw new Error(`several spaces are configured; pick one of: ${names.join(', ')}`);
  }
  if (!links[name]) throw new Error(`no space named "${name}"; known spaces: ${names.join(', ') || 'none'}`);
  const space = await Space.open(links[name], { as: author(cfg), ...opts });
  return { name, space, link: links[name] };
}

// Per-machine memory of how far each space has been read, so `pull` can say what is new.
const statePath = () => join(dirname(configPath()), 'state.json');

export function loadState() {
  try { const st = JSON.parse(readFileSync(statePath(), 'utf8')); return st && typeof st === 'object' ? st : {}; } catch { return {}; }
}

export function saveState(state) {
  mkdirSync(dirname(statePath()), { recursive: true, mode: 0o700 });
  writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
