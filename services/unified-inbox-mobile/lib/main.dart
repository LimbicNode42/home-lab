import 'dart:async';

import 'package:flutter/material.dart';

import 'src/api_client.dart';
import 'src/android_sms_mms.dart';
import 'src/inbox_home.dart';
import 'src/sync_worker.dart';

/// Default backend base URL for local/LAN development on the homelab.
///
/// Override at runtime via `--dart-define=UNIFIED_INBOX_BASE_URL=...`. This is
/// a read-only client, so the URL points at the backend's GET-only endpoints.
const String defaultBaseUrl = String.fromEnvironment(
  'UNIFIED_INBOX_BASE_URL',
  defaultValue: 'http://192.168.0.50:8766',
);

/// Provisioned upload token + device identity for the Android SMS/MMS ingestion
/// worker. These are supplied at build time from Vaultwarden via dart-define and
/// are never committed to source. When the token is empty, ingestion is disabled
/// (the worker no-ops on the gate / token check) and the client stays read-only.
const String androidUploadToken = String.fromEnvironment('ANDROID_UPLOAD_TOKEN');
const String androidDeviceRef =
    String.fromEnvironment('ANDROID_DEVICE_REF', defaultValue: 'android-device');

/// Ingestion salt: mixed into address/conversation hashing so identity is stable
/// per device but not derivable from the (redacted) phone tail alone.
const String androidDeviceSalt =
    String.fromEnvironment('ANDROID_DEVICE_SALT', defaultValue: 'device-local-salt');

/// How often the ingestion worker attempts a drain→map→upload→ack pass while the
/// app is foregrounded and the connector gate is satisfied.
const Duration syncInterval = Duration(minutes: 1);

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const UnifiedInboxApp());
}

/// Root application widget for the read-only unified inbox client.
class UnifiedInboxApp extends StatefulWidget {
  const UnifiedInboxApp({super.key, this.baseUrl = defaultBaseUrl});

  /// Base URL for the backend, overridable for tests.
  final String baseUrl;

  @override
  State<UnifiedInboxApp> createState() => _UnifiedInboxAppState();
}

class _UnifiedInboxAppState extends State<UnifiedInboxApp>
    with WidgetsBindingObserver {
  Timer? _syncTimer;
  AndroidSmsMmsSyncWorker? _syncWorker;

  AndroidSmsMmsSyncWorker? _buildWorker() {
    if (androidUploadToken.isEmpty) return null;
    return AndroidSmsMmsSyncWorker(
      platform: AndroidSmsMmsPlatform(),
      mapper: AndroidSmsMmsMapper(
        deviceRef: androidDeviceRef,
        deviceSalt: androidDeviceSalt,
        nowUtc: () => DateTime.now().toUtc(),
      ),
      syncClient: AndroidSmsMmsSyncClient(
        baseUrl: widget.baseUrl,
        uploadToken: androidUploadToken,
      ),
    );
  }

  void _startSyncIfEligible() {
    _syncTimer?.cancel();
    _syncTimer = null;
    final worker = _syncWorker ??= _buildWorker();
    if (worker == null) return;
    _syncTimer = Timer.periodic(syncInterval, (_) => worker.syncOnce());
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _startSyncIfEligible();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      // Refresh on foreground so newly delivered SMS/MMS get a prompt drain.
      _syncWorker?.syncOnce();
      _startSyncIfEligible();
    } else if (state == AppLifecycleState.paused) {
      _syncTimer?.cancel();
      _syncTimer = null;
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _syncTimer?.cancel();
    super.dispose();
  }

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
        apiClient: UnifiedInboxApiClient(baseUrl: widget.baseUrl),
      ),
    );
  }
}