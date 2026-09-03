import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:unified_inbox_mobile/src/android_sms_mms.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('AndroidSmsMmsConnectorState', () {
    test('does not request the default SMS role before explicit user action', () async {
      final calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
        AndroidSmsMmsPlatform.channel,
        (call) async {
          calls.add(call);
          if (call.method == 'getRoleState') {
            return {
              'platform': 'android',
              'roleAvailable': true,
              'roleHeld': false,
              'permissionState': 'not_requested',
            };
          }
          throw PlatformException(code: 'unexpected_call', message: call.method);
        },
      );
      addTearDown(() {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
          AndroidSmsMmsPlatform.channel,
          null,
        );
      });

      final platform = AndroidSmsMmsPlatform();
      final state = await platform.getRoleState();

      expect(state.ingestionState, AndroidSmsMmsIngestionState.roleRequired);
      expect(calls.map((c) => c.method), ['getRoleState']);
    });

    test('permission request is blocked until the default SMS role is held', () async {
      const gate = AndroidSmsMmsGate(
        roleAvailable: true,
        roleHeld: false,
        permissionState: AndroidSmsMmsPermissionState.notRequested,
      );

      expect(gate.canRequestSmsPermissions, isFalse);
      expect(gate.ingestionState, AndroidSmsMmsIngestionState.roleRequired);
    });
  });

  group('AndroidSmsMmsMapper', () {
    test('maps synthetic SMS rows to minimized normalized envelopes', () {
      final mapper = AndroidSmsMmsMapper(
        deviceRef: 'pixel-emulator',
        deviceSalt: 'fixture-salt',
        nowUtc: () => DateTime.parse('2026-09-03T00:00:03.000Z'),
      );

      final envelope = mapper.smsRowToEnvelope(
        const AndroidSmsRow(
          providerRowId: '42',
          threadId: '7',
          address: '+15555550123',
          body: 'Synthetic hello from emulator.',
          dateMillis: 1788393600000,
          type: AndroidSmsDirection.inbound,
        ),
        batchId: 'android-sms-mms-pixel-emulator-20260903T000003Z',
      );

      expect(envelope['source'], 'android-sms-mms');
      expect(envelope['account_ref'], 'android-sms-mms/pixel-emulator');
      expect(envelope['conversation_id'], startsWith('android-sms-mms:pixel-emulator:'));
      expect(envelope['thread_id'], '7');
      expect(envelope['message_id'], startsWith('sms:42:1788393600000:'));
      expect((envelope['sender'] as Map)['handle'], 'redacted:0123');
      expect(envelope['body_text'], 'Synthetic hello from emulator.');
      expect(envelope['attachment_refs'], isEmpty);
      expect((envelope['raw_ref'] as Map)['local_ref'], isNot(contains('+15555550123')));
    });

    test('maps MMS rows as metadata-only attachment references', () {
      final mapper = AndroidSmsMmsMapper(
        deviceRef: 'pixel-emulator',
        deviceSalt: 'fixture-salt',
        nowUtc: () => DateTime.parse('2026-09-03T00:00:03.000Z'),
      );

      final envelope = mapper.mmsRowToEnvelope(
        const AndroidMmsRow(
          providerRowId: '9',
          threadId: '3',
          address: '+15555550199',
          text: null,
          dateMillis: 1788393605000,
          parts: [
            AndroidMmsPart(partId: 'p1', contentType: 'image/png', filename: 'photo.png', sizeBytes: 2048),
          ],
        ),
        batchId: 'android-sms-mms-pixel-emulator-20260903T000003Z',
      );

      final attachment = (envelope['attachment_refs'] as List).single as Map<String, dynamic>;
      expect(envelope['body_text'], isNull);
      expect(attachment['name'], 'photo.png');
      expect(attachment['content_type'], 'image/png');
      expect(attachment['size'], 2048);
      expect(attachment['upstream_url_ref'], isNull);
      expect(attachment.toString(), isNot(contains('+15555550199')));
    });
  });

  group('AndroidSmsMmsSyncClient', () {
    test('uploads authenticated batches and preserves cursor commit', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(
          '{"ok":true,"accepted_count":1,"deduped_count":0,"latest_batch_id":"batch-1","cursor_commit":{"sms_high_watermark":"sms:42","mms_high_watermark":"mms:9","last_message_id":"sms:42"}}',
          202,
          headers: {'content-type': 'application/json'},
        );
      });
      final sync = AndroidSmsMmsSyncClient(
        baseUrl: 'http://example.test',
        uploadToken: 'test-upload-token',
        httpClient: client,
      );

      final response = await sync.uploadBatch(
        AndroidSmsMmsBatch(
          accountRef: 'android-sms-mms/pixel-emulator',
          deviceRef: 'pixel-emulator',
          cursorBefore: const AndroidSmsMmsCursor(smsHighWatermark: 'sms:41'),
          cursorAfter: const AndroidSmsMmsCursor(smsHighWatermark: 'sms:42', mmsHighWatermark: 'mms:9'),
          messages: const [],
        ),
      );

      expect(captured.method, 'POST');
      expect(captured.url.path, '/api/unified-inbox/connectors/android-sms-mms/batches');
      expect(captured.headers['authorization'], 'Bearer test-upload-token');
      expect(response.acceptedCount, 1);
      expect(response.cursorCommit.lastMessageId, 'sms:42');
    });
  });

  test('Android manifest declares default SMS handler components without send permission', () async {
    final manifest = File('android/app/src/main/AndroidManifest.xml').readAsStringSync();

    expect(manifest, contains('android.permission.READ_SMS'));
    expect(manifest, contains('android.provider.Telephony.SMS_DELIVER'));
    expect(manifest, contains('android.permission.BROADCAST_SMS'));
    expect(manifest, contains('android.provider.Telephony.WAP_PUSH_DELIVER'));
    expect(manifest, contains('android.permission.BROADCAST_WAP_PUSH'));
    expect(manifest, contains('android.intent.action.SENDTO'));
    expect(manifest, contains('android.intent.action.RESPOND_VIA_MESSAGE'));
    expect(manifest, isNot(contains('android.permission.SEND_SMS')));
  });
}
