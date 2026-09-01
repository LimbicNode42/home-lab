import { createServer } from 'node:http';
import { join } from 'node:path';
import { createApp } from './api.js';
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
const app = createApp({ store, connectors: [] });

const server = createServer(async (req, res) => {
  const request = new Request(`http://${req.headers.host ?? `${host}:${port}`}${req.url}`, { method: req.method, headers: req.headers });
  const response = await app.handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(await response.text());
});

server.listen(port, host, () => {
  console.log(`unified-inbox read-only service listening on http://${host}:${port}`);
});
