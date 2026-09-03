import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:unified_inbox_mobile/src/api_client.dart';
import 'package:unified_inbox_mobile/src/inbox_home.dart';

import 'fixtures.dart';

UnifiedInboxApiClient _apiWith(MockClient client) =>
    UnifiedInboxApiClient(baseUrl: 'http://example.test', httpClient: client);

Widget _wrap(Widget child) => MaterialApp(home: child);

void main() {
  testWidgets('renders message list with sender and body preview', (tester) async {
    final client = MockClient((request) async {
      final path = request.url.path;
      if (path.contains('/messages')) return http.Response(fixtureMessagesJson(), 200);
      if (path.contains('/conversations')) return http.Response(fixtureConversationsJson(), 200);
      return http.Response(fixtureStatusJson(), 200);
    });

    await tester.pumpWidget(_wrap(InboxHomeScreen(apiClient: _apiWith(client))));
    await tester.pumpAndSettle();

    expect(find.text('Alice'), findsOneWidget);
    expect(find.text('Hello from the unified inbox.'), findsOneWidget);
    // Read-only affordance: no reply/delete/mark-read controls exist.
    expect(find.text('Reply'), findsNothing);
    expect(find.text('Delete'), findsNothing);
    expect(find.textContaining('mark', findRichText: false), findsNothing);
  });

  testWidgets('renders empty state when no messages', (tester) async {
    final client = MockClient((request) async {
      if (request.url.path.contains('/messages')) return http.Response('{"messages": []}', 200);
      if (request.url.path.contains('/conversations')) return http.Response('{"conversations": []}', 200);
      return http.Response(fixtureStatusJson(), 200);
    });

    await tester.pumpWidget(_wrap(InboxHomeScreen(apiClient: _apiWith(client))));
    await tester.pumpAndSettle();

    expect(find.textContaining('No messages yet'), findsOneWidget);
  });

  testWidgets('renders error state when backend unreachable', (tester) async {
    final client = MockClient((request) async => http.Response('unreachable', 500));

    await tester.pumpWidget(_wrap(InboxHomeScreen(apiClient: _apiWith(client))));
    await tester.pumpAndSettle();

    expect(find.text('Could not reach the inbox backend.'), findsOneWidget);
  });

  testWidgets('renders status view with pending credentials and exclusions', (tester) async {
    final client = MockClient((request) async {
      if (request.url.path.contains('/messages')) return http.Response('{"messages": []}', 200);
      if (request.url.path.contains('/conversations')) return http.Response('{"conversations": []}', 200);
      return http.Response(fixtureStatusJson(), 200);
    });

    await tester.pumpWidget(_wrap(InboxHomeScreen(apiClient: _apiWith(client))));
    await tester.pumpAndSettle();

    // Switch to the Status tab.
    await tester.tap(find.text('Status'));
    await tester.pumpAndSettle();

    expect(find.text('Credentials pending'), findsOneWidget);
    expect(find.text('discord'), findsWidgets);
    // Exclusions sit below the connector list; scroll the status list into view.
    final statusScrollable = find.byType(Scrollable).last;
    await tester.scrollUntilVisible(find.text('whatsapp-personal-dm'), 200, scrollable: statusScrollable);
    expect(find.text('whatsapp-personal-dm'), findsOneWidget);
    expect(find.text('instagram-personal-dm'), findsOneWidget);
  });

  testWidgets('message detail shows read state and no mutating actions', (tester) async {
    final client = MockClient((request) async {
      if (request.url.path.contains('/messages')) return http.Response(fixtureMessagesJson(), 200);
      if (request.url.path.contains('/conversations')) return http.Response(fixtureConversationsJson(), 200);
      return http.Response(fixtureStatusJson(), 200);
    });

    await tester.pumpWidget(_wrap(InboxHomeScreen(apiClient: _apiWith(client))));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Alice'));
    await tester.pumpAndSettle();

    expect(find.text('State'), findsOneWidget);
    expect(find.text('unread'), findsOneWidget);
    expect(find.text('image.png'), findsOneWidget);
    // Detail view must not offer any reply/send/archive affordance.
    expect(find.byType(TextField), findsNothing);
    expect(find.text('Reply'), findsNothing);
    expect(find.text('Mark read'), findsNothing);
  });
}