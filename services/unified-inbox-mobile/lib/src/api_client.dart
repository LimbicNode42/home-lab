import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

/// Thrown when the backend responds with a non-2xx status.
class InboxApiException implements Exception {
  const InboxApiException(this.statusCode, this.message);

  final int statusCode;
  final String message;

  @override
  String toString() => 'InboxApiException($statusCode): $message';
}

/// A minimal read-only HTTP client for the unified inbox backend.
///
/// This client only ever issues GET requests against the backend's read-only
/// endpoints. There is no method here to send, reply, delete, archive, or
/// mark-read; the backend has no such endpoints either (non-GET returns 404).
class UnifiedInboxApiClient {
  UnifiedInboxApiClient({
    required this.baseUrl,
    http.Client? httpClient,
  }) : _http = httpClient ?? http.Client();

  /// Base URL of the backend, e.g. `http://192.168.0.50:8766`.
  final String baseUrl;
  final http.Client _http;

  Uri _uri(String path, [Map<String, String>? query]) {
    final base = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
    return Uri.parse('$base$path').replace(queryParameters: query);
  }

  /// Fetches sanitized service status and connector health.
  Future<InboxStatus> fetchStatus() async {
    final response = await _http.get(_uri('/api/unified-inbox/status'));
    if (response.statusCode != 200) {
      throw InboxApiException(response.statusCode, 'status fetch failed');
    }
    return InboxStatus.fromJson(jsonDecode(response.body) as Map<String, dynamic>);
  }

  /// Fetches a paginated list of normalized envelopes (messages).
  Future<List<Envelope>> fetchMessages({
    int limit = 50,
    String? source,
    String? conversationId,
  }) async {
    final query = <String, String>{
      'limit': '$limit',
      if (source != null && source.isNotEmpty) 'source': source,
      if (conversationId != null && conversationId.isNotEmpty) 'conversation_id': conversationId,
    };
    final response = await _http.get(_uri('/api/unified-inbox/messages', query));
    if (response.statusCode != 200) {
      throw InboxApiException(response.statusCode, 'messages fetch failed');
    }
    final decoded = jsonDecode(response.body) as Map<String, dynamic>;
    final list = decoded['messages'] as List<dynamic>? ?? const [];
    return list
        .whereType<Map<String, dynamic>>()
        .map(Envelope.fromJson)
        .toList();
  }

  /// Fetches conversation summaries.
  Future<List<Conversation>> fetchConversations() async {
    final response = await _http.get(_uri('/api/unified-inbox/conversations'));
    if (response.statusCode != 200) {
      throw InboxApiException(response.statusCode, 'conversations fetch failed');
    }
    final decoded = jsonDecode(response.body) as Map<String, dynamic>;
    final list = decoded['conversations'] as List<dynamic>? ?? const [];
    return list
        .whereType<Map<String, dynamic>>()
        .map(Conversation.fromJson)
        .toList();
  }

  void close() => _http.close();
}