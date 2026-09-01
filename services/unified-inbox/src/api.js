import { sanitizeForLog, assertNoSecretLeak } from './redaction.js';

const EXCLUSIONS = [
  { source: 'whatsapp-personal-dm', state: 'excluded', reason: 'unsanctioned personal DM access is out of scope' },
  { source: 'instagram-personal-dm', state: 'excluded', reason: 'unsanctioned personal DM access is out of scope' }
];

function json(data, { status = 200 } = {}) {
  assertNoSecretLeak(data);
  return new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

function html(body, { status = 200 } = {}) {
  assertNoSecretLeak(body);
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

async function connectorStatuses(connectors) {
  const statuses = [];
  for (const connector of connectors) {
    try { statuses.push({ source: connector.source, account_ref: connector.accountRef, ...(await connector.health()) }); }
    catch (error) { statuses.push(sanitizeForLog({ source: connector.source, account_ref: connector.accountRef, state: 'error', checked_at: new Date().toISOString(), last_success_at: null, last_error_code: 'health_failed', detail: error.message })); }
  }
  return statuses;
}

function snapshotStatus(snapshot) {
  if (!snapshot) return { latest_batch_id: null };
  return {
    schema_version: snapshot.schema_version,
    latest_batch_id: snapshot.latest_batch_id ?? null,
    batch_id: snapshot.batch_id ?? null,
    record_count: snapshot.record_count ?? 0,
    min_sent_at: snapshot.min_sent_at ?? null,
    max_sent_at: snapshot.max_sent_at ?? null,
    sha256: snapshot.sha256 ?? null,
    copy_status: snapshot.copy_status ?? null,
    placements: {
      local_closed_snapshot: Boolean(snapshot.localSnapshotPath),
      nas_snapshot: Boolean(snapshot.nasSnapshotPath),
      manifest: Boolean(snapshot.manifestPath)
    }
  };
}

export function createApp({ store, connectors = [], webhookIngest = null }) {
  return {
    async handle(request) {
      const url = new URL(request.url);

      // Inbound webhook ingestion is opt-in and never reachable unless a
      // webhookIngest router is explicitly supplied. Signature verification is
      // enforced inside the stream when require_signature is true.
      if (webhookIngest?.enabled && request.method === 'POST' && url.pathname.startsWith('/api/unified-inbox/webhook/')) {
        const sourceKey = url.pathname.slice('/api/unified-inbox/webhook/'.length);
        const stream = webhookIngest.streams.get(sourceKey);
        if (!stream) return json({ error: 'not_found' }, { status: 404 });
        const rawBody = await request.text();
        const headers = Object.fromEntries(request.headers.entries());
        try {
          const envelope = await stream.receive({ rawBody, headers });
          const manifest = await store.appendBatch({ batchId: envelope.ingest_batch_id, envelopes: [envelope] });
          return json({ ok: true, record_count: manifest.record_count, latest_batch_id: manifest.latest_batch_id }, { status: 202 });
        } catch (error) {
          const status = Number(error.status) || 500;
          return json({ error: status === 401 ? 'unauthorized' : status === 400 ? 'bad_request' : 'internal_error' }, { status });
        }
      }

      if (request.method !== 'GET') return json({ error: 'not_found' }, { status: 404 });
      if (url.pathname === '/healthz') return json({ ok: true, service: 'unified-inbox' });
      if (url.pathname === '/') {
        return html(`<!doctype html><title>Unified Inbox</title><main><h1>Unified Inbox</h1><p>Read-only message aggregation backend.</p><nav><a href="/api/unified-inbox/status">Status API</a></nav></main>`);
      }
      if (url.pathname === '/api/unified-inbox/status') {
        const status = await store.status();
        return json({ service: { name: 'unified-inbox', mode: 'read_only', status: 'ok' }, connectors: await connectorStatuses(connectors), message_count: status.message_count, snapshots: snapshotStatus(status.snapshots), exclusions: EXCLUSIONS });
      }
      if (url.pathname === '/api/unified-inbox/messages') {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
        return json({ messages: await store.listMessages({ limit, source: url.searchParams.get('source'), conversation_id: url.searchParams.get('conversation_id') }) });
      }
      if (url.pathname === '/api/unified-inbox/conversations') return json({ conversations: await store.conversations() });
      return json({ error: 'not_found' }, { status: 404 });
    }
  };
}
