// Shared JSON fixtures mirroring the backend's response shapes.
// These are synthetic, non-sensitive test data only.

Map<String, dynamic> fixtureSender() => {
      'id': 'user-1',
      'display_name': 'Alice',
      'handle': 'alice#1234',
    };

Map<String, dynamic> fixtureAttachment() => {
      'name': 'image.png',
      'url': 'https://cdn.example/a.png',
      'content_type': 'image/png',
      'size_bytes': 1234,
    };

Map<String, dynamic> fixtureEnvelope() => {
      'source': 'discord',
      'account_ref': 'home-server-bot',
      'conversation_id': 'conv-123',
      'conversation_title': 'general',
      'thread_id': 'thread-9',
      'message_id': 'msg-1',
      'sender': fixtureSender(),
      'sent_at': '2026-09-01T12:00:00.000Z',
      'received_at': '2026-09-01T12:00:05.000Z',
      'body_text': 'Hello from the unified inbox.',
      'attachment_refs': [fixtureAttachment()],
      'read_state': 'unread',
      'permalink': 'https://discord.com/channels/1/2/3',
      'raw_ref': {'id': 'raw-1'},
      'ingest_batch_id': 'discord:home-server-bot:12345',
    };

Map<String, dynamic> fixtureConversation() => {
      'source': 'discord',
      'account_ref': 'home-server-bot',
      'conversation_id': 'conv-123',
      'conversation_title': 'general',
      'message_count': 3,
      'latest_sent_at': '2026-09-01T12:00:00.000Z',
    };

Map<String, dynamic> fixtureConnector(String source, String state) => {
      'source': source,
      'account_ref': 'home-server-bot',
      'state': state,
      'checked_at': '2026-09-01T12:00:00.000Z',
      'last_success_at': state == 'ok' ? '2026-09-01T12:00:00.000Z' : null,
      'last_error_code': state == 'error' ? 'fetch_failed' : null,
      'detail': 'synthetic fixture',
    };

Map<String, dynamic> fixtureStatus() => {
      'service': {'name': 'unified-inbox', 'mode': 'read_only', 'status': 'ok'},
      'message_count': 12,
      'connectors': [
        fixtureConnector('discord', 'pending_credentials'),
        fixtureConnector('telegram', 'not_configured'),
        fixtureConnector('rss', 'error'),
        fixtureConnector('email-imap', 'ok'),
      ],
      'exclusions': [
        {'source': 'whatsapp-personal-dm', 'state': 'excluded', 'reason': 'unsanctioned personal DM access is out of scope'},
        {'source': 'instagram-personal-dm', 'state': 'excluded', 'reason': 'unsanctioned personal DM access is out of scope'},
      ],
    };

/// JSON-serialized versions for API client tests.
String fixtureMessagesJson() => '{"messages": [${_json(fixtureEnvelope())}]}';

String fixtureConversationsJson() => '{"conversations": [${_json(fixtureConversation())}]}';

String fixtureStatusJson() => _json(fixtureStatus());

String _json(Map<String, dynamic> map) {
  // Minimal manual serialization to avoid importing dart:convert here.
  final entries = map.entries.map((e) => '"${e.key}":${_value(e.value)}').join(',');
  return '{$entries}';
}

String _value(Object? value) {
  if (value == null) return 'null';
  if (value is bool) return value ? 'true' : 'false';
  if (value is int || value is double) return '$value';
  if (value is String) return '"$value"';
  if (value is List) return '[${value.map(_value).join(',')}]';
  if (value is Map) return _json(Map<String, dynamic>.from(value));
  return 'null';
}