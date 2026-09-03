import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

/// Sanitized Android SMS/MMS ingestion states surfaced to UI/dashboard.
enum AndroidSmsMmsIngestionState {
  disabled,
  roleRequired,
  permissionRequired,
  syncPending,
  ok,
  degraded,
  error,
}

enum AndroidSmsMmsPermissionState { notRequested, granted, denied }

enum AndroidSmsDirection { inbound, outbound }

String _stateWireName(AndroidSmsMmsIngestionState state) {
  switch (state) {
    case AndroidSmsMmsIngestionState.disabled:
      return 'disabled';
    case AndroidSmsMmsIngestionState.roleRequired:
      return 'role_required';
    case AndroidSmsMmsIngestionState.permissionRequired:
      return 'permission_required';
    case AndroidSmsMmsIngestionState.syncPending:
      return 'sync_pending';
    case AndroidSmsMmsIngestionState.ok:
      return 'ok';
    case AndroidSmsMmsIngestionState.degraded:
      return 'degraded';
    case AndroidSmsMmsIngestionState.error:
      return 'error';
  }
}

AndroidSmsMmsPermissionState _permissionStateFromWire(Object? value) {
  switch (value) {
    case 'granted':
      return AndroidSmsMmsPermissionState.granted;
    case 'denied':
      return AndroidSmsMmsPermissionState.denied;
    default:
      return AndroidSmsMmsPermissionState.notRequested;
  }
}

/// Consent/default-handler gate. Permission requests are allowed only after the
/// default SMS role is held; no first-launch or background role prompt belongs
/// here. The actual request method is called only from explicit UI action.
class AndroidSmsMmsGate {
  const AndroidSmsMmsGate({
    required this.roleAvailable,
    required this.roleHeld,
    required this.permissionState,
    this.queuedCount = 0,
    this.lastSyncAt,
    this.errorCode,
  });

  final bool roleAvailable;
  final bool roleHeld;
  final AndroidSmsMmsPermissionState permissionState;
  final int queuedCount;
  final DateTime? lastSyncAt;
  final String? errorCode;

  bool get canRequestSmsPermissions => roleAvailable && roleHeld;

  AndroidSmsMmsIngestionState get ingestionState {
    if (!roleAvailable) return AndroidSmsMmsIngestionState.disabled;
    if (!roleHeld) return AndroidSmsMmsIngestionState.roleRequired;
    if (permissionState != AndroidSmsMmsPermissionState.granted) {
      return AndroidSmsMmsIngestionState.permissionRequired;
    }
    if (errorCode != null && errorCode!.isNotEmpty) return AndroidSmsMmsIngestionState.error;
    if (queuedCount > 0) return AndroidSmsMmsIngestionState.syncPending;
    return AndroidSmsMmsIngestionState.ok;
  }

  String get wireState => _stateWireName(ingestionState);

  factory AndroidSmsMmsGate.fromPlatform(Map<Object?, Object?> value) {
    DateTime? parsedLastSync;
    final rawLastSync = value['lastSyncAt'];
    if (rawLastSync is String) parsedLastSync = DateTime.tryParse(rawLastSync)?.toUtc();
    return AndroidSmsMmsGate(
      roleAvailable: value['roleAvailable'] == true,
      roleHeld: value['roleHeld'] == true,
      permissionState: _permissionStateFromWire(value['permissionState']),
      queuedCount: value['queuedCount'] is int ? value['queuedCount'] as int : 0,
      lastSyncAt: parsedLastSync,
      errorCode: value['errorCode'] as String?,
    );
  }
}

class AndroidSmsMmsPlatform {
  static const channel = MethodChannel('com.limbicnode.unified_inbox_mobile/android_sms_mms');

  Future<AndroidSmsMmsGate> getRoleState() async {
    final raw = await channel.invokeMapMethod<Object?, Object?>('getRoleState') ?? const {};
    return AndroidSmsMmsGate.fromPlatform(raw);
  }

  /// Must be called only after a user taps an explicit "default SMS app" action.
  Future<bool> requestDefaultSmsRole() async {
    return await channel.invokeMethod<bool>('requestDefaultSmsRole') ?? false;
  }

  Future<bool> requestSmsPermissions() async {
    return await channel.invokeMethod<bool>('requestSmsPermissions') ?? false;
  }
}

class AndroidSmsRow {
  const AndroidSmsRow({
    required this.providerRowId,
    required this.threadId,
    required this.address,
    required this.body,
    required this.dateMillis,
    required this.type,
  });

  final String providerRowId;
  final String? threadId;
  final String address;
  final String? body;
  final int dateMillis;
  final AndroidSmsDirection type;
}

class AndroidMmsPart {
  const AndroidMmsPart({
    required this.partId,
    required this.contentType,
    this.filename,
    this.sizeBytes,
  });

  final String partId;
  final String contentType;
  final String? filename;
  final int? sizeBytes;
}

class AndroidMmsRow {
  const AndroidMmsRow({
    required this.providerRowId,
    required this.threadId,
    required this.address,
    required this.text,
    required this.dateMillis,
    required this.parts,
  });

  final String providerRowId;
  final String? threadId;
  final String address;
  final String? text;
  final int dateMillis;
  final List<AndroidMmsPart> parts;
}

class AndroidSmsMmsMapper {
  AndroidSmsMmsMapper({
    required this.deviceRef,
    required this.deviceSalt,
    required this.nowUtc,
  });

  final String deviceRef;
  final String deviceSalt;
  final DateTime Function() nowUtc;

  String get accountRef => 'android-sms-mms/$deviceRef';

  Map<String, dynamic> smsRowToEnvelope(AndroidSmsRow row, {required String batchId}) {
    final addressHash = _hashAddress(row.address);
    return _baseEnvelope(
      provider: 'sms',
      providerRowId: row.providerRowId,
      threadId: row.threadId,
      address: row.address,
      addressHash: addressHash,
      dateMillis: row.dateMillis,
      bodyText: row.body,
      attachments: const [],
      messageId: 'sms:${row.providerRowId}:${row.dateMillis}:$addressHash',
      batchId: batchId,
      senderId: row.type == AndroidSmsDirection.outbound ? 'self' : addressHash,
    );
  }

  Map<String, dynamic> mmsRowToEnvelope(AndroidMmsRow row, {required String batchId}) {
    final addressHash = _hashAddress(row.address);
    final attachments = row.parts
        .map(
          (part) => {
            'id': _opaqueLocalRef('mms-part', '${row.providerRowId}:${part.partId}'),
            'name': part.filename,
            'content_type': part.contentType,
            'size': part.sizeBytes,
            'upstream_url_ref': null,
          },
        )
        .toList();
    return _baseEnvelope(
      provider: 'mms',
      providerRowId: row.providerRowId,
      threadId: row.threadId,
      address: row.address,
      addressHash: addressHash,
      dateMillis: row.dateMillis,
      bodyText: row.text,
      attachments: attachments,
      messageId: 'mms:${row.providerRowId}:${row.dateMillis}:$addressHash',
      batchId: batchId,
      senderId: addressHash,
    );
  }

  Map<String, dynamic> _baseEnvelope({
    required String provider,
    required String providerRowId,
    required String? threadId,
    required String address,
    required String addressHash,
    required int dateMillis,
    required String? bodyText,
    required List<Map<String, dynamic>> attachments,
    required String messageId,
    required String batchId,
    required String senderId,
  }) {
    final redacted = _redactedPhoneTail(address);
    return {
      'source': 'android-sms-mms',
      'account_ref': accountRef,
      'conversation_id': 'android-sms-mms:$deviceRef:${_conversationHash(address)}',
      'conversation_title': redacted,
      'thread_id': threadId,
      'message_id': messageId,
      'sender': {
        'id': senderId,
        'display_name': null,
        'handle': redacted,
      },
      'sent_at': _isoFromMillis(dateMillis),
      'received_at': nowUtc().toUtc().toIso8601String(),
      'body_text': bodyText,
      'attachment_refs': attachments,
      'read_state': 'unknown',
      'permalink': null,
      'raw_ref': {
        'device_ref': deviceRef,
        'local_provider': provider,
        'local_ref': _opaqueLocalRef(provider, providerRowId),
      },
      'ingest_batch_id': batchId,
    };
  }

  String _hashAddress(String address) => _fnv1a64('$deviceSalt|address|${_normalizeAddress(address)}');
  String _conversationHash(String address) => _fnv1a64('$deviceSalt|conversation|$deviceRef|${_normalizeAddress(address)}');
  String _opaqueLocalRef(String provider, String ref) => '$provider:${_fnv1a64('$deviceSalt|$provider|$ref')}';
}

class AndroidSmsMmsCursor {
  const AndroidSmsMmsCursor({
    this.smsHighWatermark,
    this.mmsHighWatermark,
    this.lastMessageId,
  });

  final String? smsHighWatermark;
  final String? mmsHighWatermark;
  final String? lastMessageId;

  Map<String, dynamic> toJson() => {
        'sms_high_watermark': smsHighWatermark,
        'mms_high_watermark': mmsHighWatermark,
        'last_message_id': lastMessageId,
      };

  factory AndroidSmsMmsCursor.fromJson(Map<String, dynamic> json) => AndroidSmsMmsCursor(
        smsHighWatermark: json['sms_high_watermark'] as String?,
        mmsHighWatermark: json['mms_high_watermark'] as String?,
        lastMessageId: json['last_message_id'] as String?,
      );
}

class AndroidSmsMmsBatch {
  AndroidSmsMmsBatch({
    required this.accountRef,
    required this.deviceRef,
    required this.cursorBefore,
    required this.cursorAfter,
    required this.messages,
  });

  final String accountRef;
  final String deviceRef;
  final AndroidSmsMmsCursor cursorBefore;
  final AndroidSmsMmsCursor cursorAfter;
  final List<Map<String, dynamic>> messages;

  Map<String, dynamic> toJson() => {
        'schema_version': 'android-sms-mms.v1',
        'account_ref': accountRef,
        'device_ref': deviceRef,
        'cursor_before': cursorBefore.toJson(),
        'cursor_after': cursorAfter.toJson(),
        'messages': messages,
      };
}

class AndroidSmsMmsUploadResponse {
  const AndroidSmsMmsUploadResponse({
    required this.acceptedCount,
    required this.dedupedCount,
    required this.latestBatchId,
    required this.cursorCommit,
  });

  final int acceptedCount;
  final int dedupedCount;
  final String latestBatchId;
  final AndroidSmsMmsCursor cursorCommit;

  factory AndroidSmsMmsUploadResponse.fromJson(Map<String, dynamic> json) => AndroidSmsMmsUploadResponse(
        acceptedCount: json['accepted_count'] as int? ?? 0,
        dedupedCount: json['deduped_count'] as int? ?? 0,
        latestBatchId: json['latest_batch_id'] as String? ?? '',
        cursorCommit: AndroidSmsMmsCursor.fromJson(json['cursor_commit'] as Map<String, dynamic>? ?? const {}),
      );
}

class AndroidSmsMmsSyncClient {
  AndroidSmsMmsSyncClient({
    required this.baseUrl,
    required this.uploadToken,
    http.Client? httpClient,
  }) : _http = httpClient ?? http.Client();

  final String baseUrl;
  final String uploadToken;
  final http.Client _http;

  Future<AndroidSmsMmsUploadResponse> uploadBatch(AndroidSmsMmsBatch batch) async {
    final base = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
    final response = await _http.post(
      Uri.parse('$base/api/unified-inbox/connectors/android-sms-mms/batches'),
      headers: {
        'authorization': 'Bearer $uploadToken',
        'content-type': 'application/json; charset=utf-8',
      },
      body: jsonEncode(batch.toJson()),
    );
    if (response.statusCode != 200 && response.statusCode != 202) {
      throw PlatformException(code: 'upload_failed', message: 'Android SMS/MMS upload failed: ${response.statusCode}');
    }
    return AndroidSmsMmsUploadResponse.fromJson(jsonDecode(response.body) as Map<String, dynamic>);
  }

  void close() => _http.close();
}

String _isoFromMillis(int millis) => DateTime.fromMillisecondsSinceEpoch(millis, isUtc: true).toIso8601String();

String _normalizeAddress(String address) => address.replaceAll(RegExp(r'[^0-9A-Za-z+]'), '').toLowerCase();

String _redactedPhoneTail(String address) {
  final digits = address.replaceAll(RegExp(r'\D'), '');
  if (digits.isEmpty) return 'redacted:unknown';
  return 'redacted:${digits.substring(digits.length >= 4 ? digits.length - 4 : 0)}';
}

String _fnv1a64(String input) {
  const mask = 0xffffffffffffffff;
  var hash = 0xcbf29ce484222325;
  for (final byte in utf8.encode(input)) {
    hash ^= byte;
    hash = (hash * 0x100000001b3) & mask;
  }
  return hash.toRadixString(16).padLeft(16, '0');
}
