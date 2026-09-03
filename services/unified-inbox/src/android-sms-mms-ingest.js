import { dedupeKey, validateEnvelope } from './envelope.js';
import { sanitizeForLog } from './redaction.js';

const SCHEMA_VERSION = 'android-sms-mms.v1';
const SOURCE = 'android-sms-mms';

function bearerToken(request) {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

function safeCursor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return {
    sms_high_watermark: input.sms_high_watermark == null ? null : String(input.sms_high_watermark),
    mms_high_watermark: input.mms_high_watermark == null ? null : String(input.mms_high_watermark),
    last_message_id: input.last_message_id == null ? null : String(input.last_message_id)
  };
}

function validateBatch(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be an object');
  if (payload.schema_version !== SCHEMA_VERSION) throw new Error('invalid schema_version');
  if (typeof payload.account_ref !== 'string' || !payload.account_ref.startsWith(`${SOURCE}/`)) throw new Error('invalid account_ref');
  if (typeof payload.device_ref !== 'string' || payload.device_ref.trim() === '') throw new Error('invalid device_ref');
  const cursorBefore = safeCursor(payload.cursor_before);
  const cursorAfter = safeCursor(payload.cursor_after);
  if (!cursorBefore || !cursorAfter) throw new Error('invalid cursor');
  if (!Array.isArray(payload.messages)) throw new Error('messages must be an array');
  const envelopes = payload.messages.map((message) => {
    const envelope = validateEnvelope(message);
    if (envelope.source !== SOURCE) throw new Error('invalid message source');
    if (envelope.account_ref !== payload.account_ref) throw new Error('message account_ref mismatch');
    if (envelope.raw_ref?.device_ref && envelope.raw_ref.device_ref !== payload.device_ref) throw new Error('message device_ref mismatch');
    return envelope;
  });
  return { accountRef: payload.account_ref, deviceRef: payload.device_ref, cursorBefore, cursorAfter, envelopes };
}

export class AndroidSmsMmsIngestEndpoint {
  constructor({ store, uploadToken, now = () => new Date().toISOString() }) {
    this.store = store;
    this.uploadToken = uploadToken;
    this.now = now;
    this.latest = null;
  }

  get enabled() { return Boolean(this.uploadToken); }

  async handle(request) {
    if (!this.enabled) return { status: 404, body: { error: 'not_found' } };
    if (bearerToken(request) !== this.uploadToken) return { status: 401, body: { error: 'unauthorized' } };

    let parsed;
    try {
      parsed = validateBatch(await request.json());
    } catch (error) {
      return { status: 400, body: { error: 'bad_request' }, log: sanitizeForLog({ error: error.message }) };
    }

    const batchId = `android-sms-mms-${parsed.deviceRef}-${this.now().replaceAll(/[^0-9TZ]/g, '')}`;
    const accepted = [];
    let dedupedCount = 0;
    const seen = new Set();
    for (const envelope of parsed.envelopes) {
      const key = dedupeKey(envelope);
      if (seen.has(key) || await this.store.hasEnvelope(envelope)) {
        dedupedCount += 1;
        continue;
      }
      seen.add(key);
      accepted.push(envelope);
    }

    const manifest = await this.store.appendBatch({ batchId, envelopes: accepted });
    this.latest = {
      source: SOURCE,
      account_ref: parsed.accountRef,
      state: accepted.length > 0 ? 'sync_pending' : 'ok',
      checked_at: this.now(),
      last_success_at: this.now(),
      last_error_code: null,
      detail: `latest batch accepted ${manifest.record_count}, deduped ${dedupedCount}`,
      accepted_count: manifest.record_count,
      deduped_count: dedupedCount,
      latest_batch_id: manifest.latest_batch_id,
      cursor_commit: parsed.cursorAfter
    };

    return {
      status: 202,
      body: {
        ok: true,
        accepted_count: manifest.record_count,
        deduped_count: dedupedCount,
        latest_batch_id: manifest.latest_batch_id,
        cursor_commit: parsed.cursorAfter
      }
    };
  }

  async health() {
    if (!this.enabled) {
      return {
        source: SOURCE,
        account_ref: null,
        state: 'disabled',
        checked_at: this.now(),
        last_success_at: null,
        last_error_code: null,
        detail: 'Android SMS/MMS upload token is not configured'
      };
    }
    if (this.latest) return this.latest;
    return {
      source: SOURCE,
      account_ref: null,
      state: 'role_required',
      checked_at: this.now(),
      last_success_at: null,
      last_error_code: null,
      detail: 'Default SMS role and explicit device consent required before ingestion'
    };
  }
}

export { SCHEMA_VERSION as ANDROID_SMS_MMS_SCHEMA_VERSION, SOURCE as ANDROID_SMS_MMS_SOURCE };
