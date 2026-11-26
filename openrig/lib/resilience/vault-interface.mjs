import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const SAFE_VAULT_KEY_RE = /^hosts\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/fleet-manifest\.v1\.json$/;
export const MAX_VAULT_BYTES = 2 * 1024 * 1024;
export function assertValidStateVaultAdapter(adapter) {
  if (typeof adapter?.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(adapter.id) ||
    !adapter.capabilities || ['read', 'write', 'list', 'encrypted'].some(k => typeof adapter.capabilities[k] !== 'boolean') ||
    ['read', 'write', 'list', 'health'].some(k => typeof adapter[k] !== 'function')) throw new TypeError('Invalid state vault adapter');
  return adapter;
}

/** Local JSON only: restrictive file permissions do not encrypt payloads. No timers. */
export class LocalFsVaultAdapter {
  constructor({ baseDir = path.join(os.homedir(), '.config', 'rig-commander', 'resilience') } = {}) {
    this.id = 'local-fs';
    this.baseDir = path.resolve(baseDir);
    this.capabilities = Object.freeze({ read: true, write: true, list: true, encrypted: false, atomicWrite: true });
  }
  async _root() {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.baseDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe vault root');
    return fs.realpath(this.baseDir);
  }
  async _directory(root, parts, create = false) {
    let dir = root;
    for (const part of parts) {
      dir = path.join(dir, part);
      if (create) await fs.mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const stat = await fs.lstat(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe vault directory');
    }
    return dir;
  }
  _key(key) {
    if (typeof key !== 'string' || key.includes('..') || !SAFE_VAULT_KEY_RE.test(key)) throw new TypeError('Invalid vault key');
    return key.split('/');
  }
  async read(key) {
    const parts = this._key(key);
    let handle;
    try {
      const dir = await this._directory(await this._root(), parts.slice(0, -1));
      handle = await fs.open(path.join(dir, parts.at(-1)), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_VAULT_BYTES) throw new Error('Invalid vault file size or type');
      const buffer = Buffer.alloc(MAX_VAULT_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_VAULT_BYTES) throw new Error('Vault file too large');
      return JSON.parse(buffer.subarray(0, size).toString('utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { await handle?.close(); }
  }
  async write(key, envelope) {
    const parts = this._key(key);
    const body = JSON.stringify(envelope);
    if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_VAULT_BYTES) throw new RangeError('Vault payload too large');
    const root = await this._root();
    const dir = await this._directory(root, parts.slice(0, -1), true);
    const destination = path.join(dir, parts.at(-1));
    const existing = await fs.lstat(destination).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Unsafe vault file');
    const temp = path.join(dir, `.manifest-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(body, 'utf8');
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close(); handle = null;
      await this._directory(root, parts.slice(0, -1));
      await fs.rename(temp, destination);
      const directory = await fs.open(dir, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await handle?.close();
      await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
    return envelope;
  }
  async list(prefix = 'hosts/') {
    if (typeof prefix !== 'string' || !/^(?:hosts\/?|hosts\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/?)?$/.test(prefix)) throw new TypeError('Invalid vault prefix');
    const root = await this._root();
    let hosts;
    try { hosts = await this._directory(root, ['hosts']); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const keys = [];
    for (const entry of await fs.readdir(hosts, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const key = `hosts/${entry.name}/fleet-manifest.v1.json`;
      if (!SAFE_VAULT_KEY_RE.test(key) || !key.startsWith(prefix)) continue;
      const stat = await fs.lstat(path.join(hosts, entry.name, 'fleet-manifest.v1.json')).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
      if (stat?.isFile() && !stat.isSymbolicLink()) keys.push(key);
    }
    return keys.sort();
  }
  async health() {
    try {
      const root = await this._root();
      await fs.access(root, constants.R_OK | constants.W_OK);
      return { adapterId: this.id, healthy: true, encrypted: false };
    } catch { return { adapterId: this.id, healthy: false, encrypted: false }; }
  }
}
