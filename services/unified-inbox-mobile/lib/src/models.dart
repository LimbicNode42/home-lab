/// Data models for the read-only unified inbox backend.
///
/// These mirror the normalized envelope shape and status payload served by the
/// `services/unified-inbox` Node backend. See that service's README and ADR for
/// the canonical field definitions. This client is read-only: the models expose
/// parsed data and never construct any write/action request.
library;

/// The three read states the backend reports for an envelope.
const readStates = {'unknown', 'unread', 'read'};

/// A sender as projected by the backend envelope.
class Sender {
  const Sender({this.id, this.displayName, this.handle});

  final String? id;
  final String? displayName;
  final String? handle;

  factory Sender.fromJson(Map<String, dynamic> json) => Sender(
        id: json['id'] as String?,
        displayName: json['display_name'] as String?,
        handle: json['handle'] as String?,
      );

  /// Human label for the sender, with sensible fallbacks.
  String get label {
    if (displayName != null && displayName!.isNotEmpty) return displayName!;
    if (handle != null && handle!.isNotEmpty) return handle!;
    if (id != null && id!.isNotEmpty) return id!;
    return 'unknown';
  }
}

/// An attachment reference. The backend projects references/links only; the
/// client never fetches or renders attachment contents.
class AttachmentRef {
  const AttachmentRef({this.name, this.url, this.contentType, this.sizeBytes});

  final String? name;
  final String? url;
  final String? contentType;
  final int? sizeBytes;

  factory AttachmentRef.fromJson(Map<String, dynamic> json) => AttachmentRef(
        name: json['name'] as String?,
        url: json['url'] as String?,
        contentType: json['content_type'] as String? ?? json['contentType'] as String?,
        sizeBytes: json['size_bytes'] as int? ?? json['size'] as int?,
      );
}

/// A normalized envelope (message) as served by
/// `GET /api/unified-inbox/messages`.
class Envelope {
  const Envelope({
    required this.source,
    required this.accountRef,
    required this.conversationId,
    required this.messageId,
    required this.sentAt,
    required this.receivedAt,
    required this.readState,
    required this.attachmentRefs,
    this.conversationTitle,
    this.threadId,
    this.sender,
    this.bodyText,
    this.permalink,
  });

  final String source;
  final String accountRef;
  final String conversationId;
  final String? conversationTitle;
  final String? threadId;
  final String messageId;
  final Sender? sender;
  final DateTime sentAt;
  final DateTime receivedAt;
  final String? bodyText;
  final List<AttachmentRef> attachmentRefs;
  final String readState;
  final String? permalink;

  bool get isUnread => readState == 'unread';
  bool get isRead => readState == 'read';

  factory Envelope.fromJson(Map<String, dynamic> json) {
    final rawSender = json['sender'];
    final rawAttachments = json['attachment_refs'] as List<dynamic>? ?? const [];
    return Envelope(
      source: json['source'] as String? ?? 'unknown',
      accountRef: json['account_ref'] as String? ?? 'unknown',
      conversationId: json['conversation_id'] as String? ?? '',
      conversationTitle: json['conversation_title'] as String?,
      threadId: json['thread_id'] as String?,
      messageId: json['message_id'] as String? ?? '',
      sender: rawSender is Map<String, dynamic> ? Sender.fromJson(rawSender) : null,
      sentAt: _parseTimestamp(json['sent_at']),
      receivedAt: _parseTimestamp(json['received_at']),
      bodyText: json['body_text'] as String?,
      attachmentRefs: rawAttachments
          .whereType<Map<String, dynamic>>()
          .map(AttachmentRef.fromJson)
          .toList(),
      readState: readStates.contains(json['read_state']) ? json['read_state'] as String : 'unknown',
      permalink: json['permalink'] as String?,
    );
  }
}

DateTime _parseTimestamp(Object? value) {
  if (value is String) {
    final parsed = DateTime.tryParse(value);
    if (parsed != null) return parsed.toUtc();
  }
  return DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);
}

/// A conversation summary as served by
/// `GET /api/unified-inbox/conversations`.
class Conversation {
  const Conversation({
    required this.source,
    required this.accountRef,
    required this.conversationId,
    required this.messageCount,
    this.conversationTitle,
    this.latestSentAt,
  });

  final String source;
  final String accountRef;
  final String conversationId;
  final String? conversationTitle;
  final int messageCount;
  final DateTime? latestSentAt;

  factory Conversation.fromJson(Map<String, dynamic> json) => Conversation(
        source: json['source'] as String? ?? 'unknown',
        accountRef: json['account_ref'] as String? ?? 'unknown',
        conversationId: json['conversation_id'] as String? ?? '',
        conversationTitle: json['conversation_title'] as String?,
        messageCount: json['message_count'] as int? ?? 0,
        latestSentAt: json['latest_sent_at'] == null
            ? null
            : _parseTimestamp(json['latest_sent_at']),
      );
}

/// Connector health state, as projected by
/// `GET /api/unified-inbox/status`.
class ConnectorStatus {
  const ConnectorStatus({
    required this.source,
    required this.state,
    this.accountRef,
    this.checkedAt,
    this.lastSuccessAt,
    this.lastErrorCode,
    this.detail,
  });

  final String source;
  final String? accountRef;
  final String state;
  final DateTime? checkedAt;
  final DateTime? lastSuccessAt;
  final String? lastErrorCode;
  final String? detail;

  /// Whether this connector needs credentials to be configured. The backend
  /// reports `not_configured`, `disabled`, or `pending_credentials` for
  /// connectors that have no usable adapter yet.
  bool get pendingCredentials =>
      state == 'pending_credentials' ||
      state == 'not_configured' ||
      state == 'disabled';

  bool get isErrorState => state == 'error';

  factory ConnectorStatus.fromJson(Map<String, dynamic> json) => ConnectorStatus(
        source: json['source'] as String? ?? 'unknown',
        accountRef: json['account_ref'] as String?,
        state: json['state'] as String? ?? 'unknown',
        checkedAt: json['checked_at'] == null
            ? null
            : _parseTimestamp(json['checked_at']),
        lastSuccessAt: json['last_success_at'] == null
            ? null
            : _parseTimestamp(json['last_success_at']),
        lastErrorCode: json['last_error_code'] as String?,
        detail: json['detail'] as String?,
      );
}

/// An explicit exclusion row (e.g. personal WhatsApp/Instagram DMs).
class Exclusion {
  const Exclusion({required this.source, required this.state, this.reason});

  final String source;
  final String state;
  final String? reason;

  factory Exclusion.fromJson(Map<String, dynamic> json) => Exclusion(
        source: json['source'] as String? ?? 'unknown',
        state: json['state'] as String? ?? 'excluded',
        reason: json['reason'] as String?,
      );
}

/// Full service status payload from `GET /api/unified-inbox/status`.
class InboxStatus {
  const InboxStatus({
    required this.serviceName,
    required this.serviceMode,
    required this.serviceStatus,
    required this.connectors,
    required this.exclusions,
    this.messageCount = 0,
  });

  final String serviceName;
  final String serviceMode;
  final String serviceStatus;
  final List<ConnectorStatus> connectors;
  final List<Exclusion> exclusions;
  final int messageCount;

  bool get isReadOnly => serviceMode == 'read_only';

  factory InboxStatus.fromJson(Map<String, dynamic> json) {
    final service = json['service'] as Map<String, dynamic>? ?? const {};
    final rawConnectors = json['connectors'] as List<dynamic>? ?? const [];
    final rawExclusions = json['exclusions'] as List<dynamic>? ?? const [];
    return InboxStatus(
      serviceName: service['name'] as String? ?? 'unified-inbox',
      serviceMode: service['mode'] as String? ?? 'read_only',
      serviceStatus: service['status'] as String? ?? 'unknown',
      connectors: rawConnectors
          .whereType<Map<String, dynamic>>()
          .map(ConnectorStatus.fromJson)
          .toList(),
      exclusions: rawExclusions
          .whereType<Map<String, dynamic>>()
          .map(Exclusion.fromJson)
          .toList(),
      messageCount: json['message_count'] as int? ?? 0,
    );
  }
}