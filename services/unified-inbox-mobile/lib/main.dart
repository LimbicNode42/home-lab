import 'package:flutter/material.dart';

import 'src/api_client.dart';
import 'src/inbox_home.dart';

/// Default backend base URL for local/LAN development on the homelab.
///
/// Override at runtime via `--dart-define=UNIFIED_INBOX_BASE_URL=...`. This is
/// a read-only client, so the URL points at the backend's GET-only endpoints.
const String defaultBaseUrl = String.fromEnvironment(
  'UNIFIED_INBOX_BASE_URL',
  defaultValue: 'http://192.168.0.50:8766',
);

void main() {
  runApp(const UnifiedInboxApp());
}

/// Root application widget for the read-only unified inbox client.
class UnifiedInboxApp extends StatelessWidget {
  const UnifiedInboxApp({super.key, this.baseUrl = defaultBaseUrl});

  /// Base URL for the backend, overridable for tests.
  final String baseUrl;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Unified Inbox',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo),
        useMaterial3: true,
      ),
      home: InboxHomeScreen(
        apiClient: UnifiedInboxApiClient(baseUrl: baseUrl),
      ),
    );
  }
}