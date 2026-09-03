import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:unified_inbox_mobile/src/android_sms_mms.dart';
import 'package:unified_inbox_mobile/src/sync_worker.dart';

/// In-memory stand-in for the Kotlin encrypted queue + cursor, driven through the
/// real MethodChannel mock so the worker exercises the same wire path as prod.
class _FakeQueueBridge {
  _FakeQueueBridge({List<String>? staged, this.cursor}) : staged = staged ?? [];

  List<String> staged;
  String? cursor;
  int lastSyncAtWrites = 0;

  void install() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(AndroidSmsMmsPlatform.channel, (call) async {
      switch (call.method) {
        case 'getRoleState':
          return {
            'platform': 'android',
            'roleAvailable': true,
            'roleHeld': true,
            'permissionState': 'granted',
          };
        case 'peekStagedMessages':
          return staged;
        case 'ackStagedMessages':
          final count = (call.arguments as Map<Object?, Object?>)['count'] as int;
          staged = staged.sublist(count.clamp(0, staged.length));
          lastSyncAtWrites += 1;
          return null;
        case 'readCursor':
          return cursor;
        case 'writeCursor':
          cursor = (call.arguments as Map<Object?, Object?>)['cursor'] as String?;
          return null;
        default:
          throw PlatformException(code: 'unexpected_call', message: call.method);
      }
    });
  }

  void uninstall() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(AndroidSmsMmsPlatform.channel, null);
  }
}

AndroidSmsMmsSyncWorker _worker({
  required _FakeQueueBridge bridge,
  required http.Client httpClient,
}) {
  return AndroidSmsMmsSyncWorker(
    platform: AndroidSmsMmsPlatform(),
    mapper: AndroidSmsMmsMapper(
      deviceRef: 'pixel-emulator',
      deviceSalt: 'fixture-salt',
      nowUtc: () => DateTime.parse('2026-09-03T00:00:03.000Z'),
    ),
    syncClient: AndroidSmsMmsSyncClient(
      baseUrl: 'http://example.test',
      uploadToken: 'test-upload-token',
      httpClient: httpClient,
    ),
  );
}

String _smsStaged(String providerRowId, String address, String body, int dateMillis) {
  return jsonEncode({
    'local_provider': 'sms',
    'provider_row_id': providerRowId,
    'address': address,
    'body': body,
    'date_millis': dateMillis,
    'received_at': '2026-09-03T00:00:02.000Z',
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(AndroidSmsMmsPlatform.channel, null);
  });

  group('AndroidSmsMmsSyncWorker', () {
    test('happy path: drains, maps, uploads, then acks and commits cursor only on ack', () async {
      final bridge = _FakeQueueBridge(
        staged: [_smsStaged('42', '+15550000123', 'hello', 1788393600000)],
      );
      bridge.install();
      addTearDown(bridge.uninstall);

      late http.Request captured;
      final httpClient = MockClient((request) async {
        captured = request;
        return http.Response(
          '{"ok":true,"accepted_count":1,"deduped_count":0,"latest_batch_id":"batch-1",'
          '"cursor_commit":{"sms_high_watermark":"sms:42:1788393600000:addr","mms_high_watermark":null,"last_message_id":"sms:42:1788393600000:addr"}}',
          202,
          headers: {'content-type': 'application/json'},
        );
      });

      final outcome = await _worker(bridge: bridge, httpClient: httpClient).syncOnce();

      expect(outcome, AndroidSmsMmsSyncOutcome.uploaded);
      expect(captured.method, 'POST');
      expect(captured.url.path, '/api/unified-inbox/connectors/android-sms-mms/batches');
      expect(captured.headers['authorization'], 'Bearer test-upload-token');

      final body = jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['messages'], hasLength(1));
      expect((body['messages'] as List).first['source'], 'android-sms-mms');

      // Staged messages removed and cursor written after ack.
      expect(bridge.staged, isEmpty);
      expect(bridge.cursor, isNotNull);
      expect(bridge.lastSyncAtWrites, 1);
    });

    test('failed upload retains staged messages and does not advance cursor', () async {
      final bridge = _FakeQueueBridge(
        staged: [_smsStaged('42', '+15550000123', 'hello', 1788393600000)],
      );
      bridge.install();
      addTearDown(bridge.uninstall);

      final httpClient = MockClient((request) async => http.Response('boom', 500));

      final outcome = await _worker(bridge: bridge, httpClient: httpClient).syncOnce();

      expect(outcome, AndroidSmsMmsSyncOutcome.failed);
      // No data loss: staged message retained, cursor untouched, no ack write.
      expect(bridge.staged, hasLength(1));
      expect(bridge.cursor, isNull);
      expect(bridge.lastSyncAtWrites, 0);
    });

    test('cursor records ack-side high watermarks from the committed response', () async {
      final bridge = _FakeQueueBridge(
        staged: [_smsStaged('42', '+15550000123', 'hello', 1788393600000)],
        cursor: '{"sms_high_watermark":"sms:41","mms_high_watermark":null,"last_message_id":"sms:41"}',
      );
      bridge.install();
      addTearDown(bridge.uninstall);

      final httpClient = MockClient((request) async {
        return http.Response(
          '{"ok":true,"accepted_count":0,"deduped_count":1,"latest_batch_id":"batch-1",'
          '"cursor_commit":{"sms_high_watermark":"hm-42","mms_high_watermark":"hm-9","last_message_id":"hm-42"}}',
          202,
          headers: {'content-type': 'application/json'},
        );
      });

      final outcome = await _worker(bridge: bridge, httpClient: httpClient).syncOnce();

      expect(outcome, AndroidSmsMmsSyncOutcome.uploaded);
      final cursor = jsonDecode(bridge.cursor!) as Map<String, dynamic>;
      // Cursor reflects the backend cursor_commit ack, not a locally-derived value.
      expect(cursor['sms_high_watermark'], 'hm-42');
      expect(cursor['mms_high_watermark'], 'hm-9');
      expect(cursor['last_message_id'], 'hm-42');
    });

    test('returns notReady when the connector gate is not satisfied', () async {
      final bridge = _FakeQueueBridge(
        staged: [_smsStaged('42', '+15550000123', 'hello', 1788393600000)],
      );
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(AndroidSmsMmsPlatform.channel, (call) async {
        if (call.method == 'getRoleState') {
          return {'platform': 'android', 'roleAvailable': true, 'roleHeld': false, 'permissionState': 'not_requested'};
        }
        throw PlatformException(code: 'unexpected_call', message: call.method);
      });
      addTearDown(() {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(AndroidSmsMmsPlatform.channel, null);
      });

      final httpClient = MockClient((request) async => http.Response('{}', 202));
      final outcome = await _worker(bridge: bridge, httpClient: httpClient).syncOnce();

      expect(outcome, AndroidSmsMmsSyncOutcome.notReady);
      expect(bridge.staged, hasLength(1));
      expect(bridge.cursor, isNull);
    });

    test('returns idle when no staged messages are waiting', () async {
      final bridge = _FakeQueueBridge();
      bridge.install();
      addTearDown(bridge.uninstall);

      final httpClient = MockClient((request) async => http.Response('{}', 202));
      final outcome = await _worker(bridge: bridge, httpClient: httpClient).syncOnce();

      expect(outcome, AndroidSmsMmsSyncOutcome.idle);
    });
  });
}