import 'dart:convert';

import 'android_sms_mms.dart';

/// Result of a single drain→map→upload→ack pass. Surfaced so callers (and tests)
/// can reason about what happened without reaching into platform state.
enum AndroidSmsMmsSyncOutcome {
  /// The connector gate (default SMS role + permissions) was not satisfied; no
  /// work was attempted. This is not an error.
  notReady,

  /// No staged messages were waiting; nothing to upload.
  idle,

  /// A batch was uploaded and acknowledged successfully.
  uploaded,

  /// The upload failed. Staged messages are intentionally retained so a later
  /// retry is lossless; the local cursor is not advanced.
  failed,
}

/// The end-to-end ingestion worker.
///
/// This is the missing "Sync worker" component from the reviewed design: it
/// drains staged messages from the encrypted queue, maps them to normalized
/// envelopes, POSTs an authenticated batch, and only advances the cursor — and
/// only removes staged messages — after the backend acknowledges the batch.
///
/// It is strictly read-only upstream. It never sends, replies, deletes,
/// archives, or marks-read; the only write it performs is the authenticated
/// ingestion `POST` plus its own local cursor/queue bookkeeping.
class AndroidSmsMmsSyncWorker {
  AndroidSmsMmsSyncWorker({
    required this.platform,
    required this.mapper,
    required this.syncClient,
    this.maxBatchSize = 200,
    DateTime Function()? nowUtc,
  }) : _nowUtc = nowUtc ?? DateTime.now;

  final AndroidSmsMmsPlatform platform;
  final AndroidSmsMmsMapper mapper;
  final AndroidSmsMmsSyncClient syncClient;
  final int maxBatchSize;
  final DateTime Function() _nowUtc;

  /// Runs one drain→map→upload→ack pass. Safe to call repeatedly (e.g. from a
  /// scheduler or app-resume): each pass advances no further than the backend
  /// disclaims acknowledgment for.
  Future<AndroidSmsMmsSyncOutcome> syncOnce() async {
    final gate = await platform.getRoleState();
    if (!gate.isReadyForIngest) return AndroidSmsMmsSyncOutcome.notReady;

    final staged = await platform.peekStagedMessages();
    if (staged.isEmpty) return AndroidSmsMmsSyncOutcome.idle;

    final limited = staged.take(maxBatchSize).toList();

    final cursorBefore = await _readCursor();
    final batchId = _batchId();
    final envelopes = <Map<String, dynamic>>[];
    for (final raw in limited) {
      Map<String, dynamic>? decoded;
      try {
        decoded = jsonDecode(raw) as Map<String, dynamic>;
      } catch (_) {
        // A corrupt staged row cannot be repaired here; skip it so it never
        // wedges the batch upload, and let the ack-on-success path retire it.
        continue;
      }
      final envelope = mapper.stagedJsonToEnvelope(decoded, batchId: batchId);
      if (envelope != null) envelopes.add(envelope);
    }

    if (envelopes.isEmpty) {
      // Nothing mapped cleanly. Drop this window so a poison row cannot wedge
      // the queue forever; the messages were unrecognizable staged data.
      await platform.ackStagedMessages(limited.length);
      return AndroidSmsMmsSyncOutcome.idle;
    }

    final cursorAfter = _cursorAfter(cursorBefore, envelopes);
    final batch = AndroidSmsMmsBatch(
      accountRef: mapper.accountRef,
      deviceRef: mapper.deviceRef,
      cursorBefore: cursorBefore,
      cursorAfter: cursorAfter,
      messages: envelopes,
    );

    try {
      final response = await syncClient.uploadBatch(batch);
      // Advance the cursor and drop the acked window only after the backend ack.
      await platform.writeCursor(jsonEncode(response.cursorCommit.toJson()));
      await platform.ackStagedMessages(limited.length);
      return AndroidSmsMmsSyncOutcome.uploaded;
    } catch (_) {
      return AndroidSmsMmsSyncOutcome.failed;
    }
  }

  Future<AndroidSmsMmsCursor> _readCursor() async {
    final raw = await platform.readCursor();
    if (raw == null || raw.isEmpty) return const AndroidSmsMmsCursor();
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map<String, dynamic>) return AndroidSmsMmsCursor.fromJson(decoded);
    } catch (_) {
      // Corrupt local cursor: start fresh rather than poisoning the batch.
    }
    return const AndroidSmsMmsCursor();
  }

  String _batchId() {
    final stamp = _nowUtc().toUtc().toIso8601String().replaceAll(RegExp(r'[^0-9TZ]'), '');
    return '${mapper.accountRef}-$stamp';
  }

  AndroidSmsMmsCursor _cursorAfter(
    AndroidSmsMmsCursor before,
    List<Map<String, dynamic>> envelopes,
  ) {
    String? smsHighWatermark = before.smsHighWatermark;
    String? mmsHighWatermark = before.mmsHighWatermark;
    String? lastMessageId = before.lastMessageId;

    for (final envelope in envelopes) {
      final provider = (envelope['raw_ref'] as Map<String, dynamic>?)?['local_provider'];
      final messageId = envelope['message_id'] as String?;
      if (messageId == null) continue;
      if (provider == 'mms') {
        mmsHighWatermark = messageId;
      } else {
        smsHighWatermark = messageId;
      }
      lastMessageId = messageId;
    }

    return AndroidSmsMmsCursor(
      smsHighWatermark: smsHighWatermark,
      mmsHighWatermark: mmsHighWatermark,
      lastMessageId: lastMessageId,
    );
  }
}