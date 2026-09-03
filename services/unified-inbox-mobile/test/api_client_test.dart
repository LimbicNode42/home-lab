import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:unified_inbox_mobile/src/api_client.dart';

import 'fixtures.dart';

void main() {
  group('UnifiedInboxApiClient', () {
    test('fetchMessages parses envelopes and issues GET only', () async {
      final client = MockClient((request) async {
        expect(request.method, 'GET');
        expect(request.url.path, '/api/unified-inbox/messages');
        expect(request.url.queryParameters['limit'], '100');
        return http.Response(fixtureMessagesJson(), 200, headers: {'content-type': 'application/json'});
      });
      final api = UnifiedInboxApiClient(baseUrl: 'http://example.test', httpClient: client);

      final messages = await api.fetchMessages(limit: 100);
      expect(messages, hasLength(1));
      expect(messages.first.messageId, 'msg-1');
      expect(messages.first.source, 'discord');
    });

    test('fetchMessages passes source and conversation filters', () async {
      late Uri captured;
      final client = MockClient((request) async {
        captured = request.url;
        return http.Response('{"messages": []}', 200);
      });
      final api = UnifiedInboxApiClient(baseUrl: 'http://example.test', httpClient: client);

      await api.fetchMessages(limit: 50, source: 'discord', conversationId: 'conv-123');
      expect(captured.queryParameters['source'], 'discord');
      expect(captured.queryParameters['conversation_id'], 'conv-123');
    });

    test('fetchStatus parses read-only status payload', () async {
      final client = MockClient((request) async {
        expect(request.method, 'GET');
        expect(request.url.path, '/api/unified-inbox/status');
        return http.Response(fixtureStatusJson(), 200, headers: {'content-type': 'application/json'});
      });
      final api = UnifiedInboxApiClient(baseUrl: 'http://example.test', httpClient: client);

      final status = await api.fetchStatus();
      expect(status.isReadOnly, isTrue);
      expect(status.connectors, hasLength(4));
    });

    test('fetchConversations parses summaries', () async {
      final client = MockClient((request) async {
        expect(request.url.path, '/api/unified-inbox/conversations');
        return http.Response(fixtureConversationsJson(), 200);
      });
      final api = UnifiedInboxApiClient(baseUrl: 'http://example.test', httpClient: client);

      final conversations = await api.fetchConversations();
      expect(conversations, hasLength(1));
      expect(conversations.first.messageCount, 3);
    });

    test('throws InboxApiException on non-200', () async {
      final client = MockClient((request) async => http.Response('{"error":"not_found"}', 404));
      final api = UnifiedInboxApiClient(baseUrl: 'http://example.test', httpClient: client);

      expect(
        () => api.fetchMessages(),
        throwsA(isA<InboxApiException>().having((e) => e.statusCode, 'statusCode', 404)),
      );
    });

    test('trailing slash on baseUrl does not produce double slashes', () async {
      late Uri captured;
      final client = MockClient((request) async {
        captured = request.url;
        return http.Response('{"messages": []}', 200);
      });
      final api = UnifiedInboxApiClient(baseUrl: 'http://example.test/', httpClient: client);

      await api.fetchMessages();
      expect(captured.path, '/api/unified-inbox/messages');
    });

    test('handles malformed JSON body gracefully', () async {
      final client = MockClient((request) async => http.Response('not json', 200));
      final api = UnifiedInboxApiClient(baseUrl: 'http://example.test', httpClient: client);

      expect(() => api.fetchMessages(), throwsA(isA<FormatException>()));
    });
  });
}