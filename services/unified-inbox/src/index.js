import { createServer } from 'node:http';
import { join } from 'node:path';
import { createApp } from './api.js';
import { AndroidSmsMmsIngestEndpoint } from './android-sms-mms-ingest.js';
import { FileSnapshotStore } from './storage.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8766);
const runtimeRoot = process.env.UNIFIED_INBOX_RUNTIME_ROOT ?? './state';
const nasRoot = process.env.UNIFIED_INBOX_NAS_ROOT ?? './state/nas-export';
const store = new FileSnapshotStore({
  stateDir: join(runtimeRoot, 'state'),
  closedSnapshotDir: join(runtimeRoot, 'snapshots', 'closed'),
  nasSnapshotDir: join(nasRoot, 'snapshots', 'normalized'),
  nasManifestDir: join(nasRoot, 'manifests')
});
const androidSmsMmsIngest = new AndroidSmsMmsIngestEndpoint({
  store,
  uploadToken: process.env.UNIFIED_INBOX_ANDROID_SMS_MMS_UPLOAD_TOKEN ?? null
});
const app = createApp({ store, connectors: [], androidSmsMmsIngest });

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

const server = createServer(async (req, res) => {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await requestBody(req);
  const request = new Request(`http://${req.headers.host ?? `${host}:${port}`}${req.url}`, { method: req.method, headers: req.headers, body });
  const response = await app.handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(await response.text());
});

server.listen(port, host, () => {
  console.log(`unified-inbox read-only service listening on http://${host}:${port}`);
});
