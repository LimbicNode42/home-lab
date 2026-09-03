import { mkdir, writeFile, rename, copyFile, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { validateEnvelope, dedupeKey } from './envelope.js';
import { assertNoCredentialLeak, assertNoSecretLeak } from './redaction.js';

function conversationKey(envelope) { return `${envelope.source}/${envelope.account_ref}/${envelope.conversation_id}`; }

export class MemorySnapshotStore {
  constructor() { this.messages = new Map(); this.batches = []; }

  async hasEnvelope(envelope) { return this.messages.has(dedupeKey(envelope)); }

  async appendBatch({ batchId, envelopes }) {
    const written = [];
    for (const input of envelopes) {
      const envelope = validateEnvelope(input);
      if (this.messages.has(dedupeKey(envelope))) continue;
      this.messages.set(dedupeKey(envelope), envelope);
      written.push(envelope);
    }
    const manifest = this.#manifest(batchId, written, { localSnapshotPath: null, nasSnapshotPath: null, manifestPath: null });
    this.batches.push(manifest);
    return manifest;
  }

  async listMessages({ limit = 50, source = null, conversation_id = null } = {}) {
    return [...this.messages.values()]
      .filter((msg) => !source || msg.source === source)
      .filter((msg) => !conversation_id || msg.conversation_id === conversation_id)
      .sort((a, b) => b.sent_at.localeCompare(a.sent_at))
      .slice(0, limit);
  }

  async conversations() {
    const groups = new Map();
    for (const msg of this.messages.values()) {
      const key = conversationKey(msg);
      const current = groups.get(key) ?? { source: msg.source, account_ref: msg.account_ref, conversation_id: msg.conversation_id, conversation_title: msg.conversation_title, message_count: 0, latest_sent_at: null };
      current.message_count += 1;
      current.latest_sent_at = !current.latest_sent_at || msg.sent_at > current.latest_sent_at ? msg.sent_at : current.latest_sent_at;
      groups.set(key, current);
    }
    return [...groups.values()].sort((a, b) => String(b.latest_sent_at).localeCompare(String(a.latest_sent_at)));
  }

  async status() {
    return { message_count: this.messages.size, snapshots: this.batches.at(-1) ?? { latest_batch_id: null } };
  }

  #manifest(batchId, envelopes, paths) {
    return {
      schema_version: 1,
      latest_batch_id: batchId,
      batch_id: batchId,
      record_count: envelopes.length,
      min_sent_at: envelopes.length ? envelopes.map((e) => e.sent_at).sort()[0] : null,
      max_sent_at: envelopes.length ? envelopes.map((e) => e.sent_at).sort().at(-1) : null,
      sha256: createHash('sha256').update(envelopes.map((e) => JSON.stringify(e)).join('\n')).digest('hex'),
      ...paths
    };
  }
}

export class FileSnapshotStore extends MemorySnapshotStore {
  constructor({ stateDir, closedSnapshotDir, nasSnapshotDir, nasManifestDir }) {
    super();
    this.stateDir = stateDir;
    this.closedSnapshotDir = closedSnapshotDir;
    this.nasSnapshotDir = nasSnapshotDir;
    this.nasManifestDir = nasManifestDir;
  }

  async appendBatch({ batchId, envelopes }) {
    const written = [];
    for (const input of envelopes) {
      const envelope = validateEnvelope(input);
      if (this.messages.has(dedupeKey(envelope))) continue;
      this.messages.set(dedupeKey(envelope), envelope);
      written.push(envelope);
    }
    await Promise.all([mkdir(this.stateDir, { recursive: true }), mkdir(this.closedSnapshotDir, { recursive: true }), mkdir(this.nasSnapshotDir, { recursive: true }), mkdir(this.nasManifestDir, { recursive: true })]);
    const jsonl = written.map((envelope) => JSON.stringify(envelope)).join('\n') + (written.length ? '\n' : '');
    assertNoSecretLeak(jsonl);
    const tmpPath = join(this.stateDir, `${batchId}.normalized.jsonl.tmp`);
    const localSnapshotPath = join(this.closedSnapshotDir, `${batchId}.normalized.jsonl`);
    const nasSnapshotPath = join(this.nasSnapshotDir, `${batchId}.normalized.jsonl`);
    await writeFile(tmpPath, jsonl, { mode: 0o600 });
    await rename(tmpPath, localSnapshotPath);
    await copyFile(localSnapshotPath, nasSnapshotPath);
    const manifest = this.#manifest(batchId, written, { localSnapshotPath, nasSnapshotPath, manifestPath: join(this.nasManifestDir, `${batchId}.manifest.json`) });
    assertNoCredentialLeak(manifest);
    await writeFile(manifest.manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    this.batches.push(manifest);
    return manifest;
  }

  #manifest(batchId, envelopes, paths) {
    return {
      schema_version: 1,
      latest_batch_id: batchId,
      batch_id: batchId,
      record_count: envelopes.length,
      min_sent_at: envelopes.length ? envelopes.map((e) => e.sent_at).sort()[0] : null,
      max_sent_at: envelopes.length ? envelopes.map((e) => e.sent_at).sort().at(-1) : null,
      sha256: createHash('sha256').update(envelopes.map((e) => JSON.stringify(e)).join('\n')).digest('hex'),
      copy_status: 'copied_to_nas_snapshot_path',
      ...paths
    };
  }
}

export async function loadJsonFileIfExists(path, fallback = null) {
  try { await stat(path); return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
