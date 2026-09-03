import 'package:flutter/material.dart';

import 'api_client.dart';
import 'models.dart';

/// Top-level screen for the read-only unified inbox.
///
/// Three read-only views:
///  - Messages: paginated normalized envelope list + detail.
///  - Conversations: conversation summaries.
///  - Status: connector health, exclusions, and service mode.
///
/// There are intentionally no reply/send/delete/archive/mark-read controls
/// anywhere in this UI; the backend is read-only and this client honours that.
class InboxHomeScreen extends StatefulWidget {
  const InboxHomeScreen({super.key, required this.apiClient});

  final UnifiedInboxApiClient apiClient;

  @override
  State<InboxHomeScreen> createState() => _InboxHomeScreenState();
}

class _InboxHomeScreenState extends State<InboxHomeScreen> {
  int _tabIndex = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Unified Inbox · Read-only'),
      ),
      body: IndexedStack(
        index: _tabIndex,
        children: [
          _MessagesView(apiClient: widget.apiClient),
          _ConversationsView(apiClient: widget.apiClient),
          _StatusView(apiClient: widget.apiClient),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tabIndex,
        onDestinationSelected: (index) => setState(() => _tabIndex = index),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.inbox_outlined), label: 'Messages'),
          NavigationDestination(icon: Icon(Icons.forum_outlined), label: 'Conversations'),
          NavigationDestination(icon: Icon(Icons.monitor_heart_outlined), label: 'Status'),
        ],
      ),
    );
  }
}

/// Shared refresh/loading/error scaffolding for each read-only view.
class _LoadableView<T> extends StatelessWidget {
  const _LoadableView({
    required this.future,
    required this.builder,
    this.emptyBuilder,
  });

  final Future<T> future;
  final Widget Function(BuildContext, T) builder;
  final Widget Function(BuildContext)? emptyBuilder;

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<T>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return _ErrorState(error: snapshot.error);
        }
        final data = snapshot.data;
        if (data == null) {
          return _ErrorState(error: 'No data returned.');
        }
        if (data is List && (data as List).isEmpty && emptyBuilder != null) {
          return emptyBuilder!(context);
        }
        return builder(context, data);
      },
    );
  }
}

/// Friendly error banner with a retry affordance (pull-to-refresh). No raw
/// diagnostics or stack traces are surfaced to the user.
class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.error});

  final Object? error;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off_outlined, size: 48),
            const SizedBox(height: 12),
            const Text('Could not reach the inbox backend.'),
            const SizedBox(height: 8),
            Text(
              'Check that the unified inbox service is reachable and try again.',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.inbox_outlined, size: 48),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}

class _MessagesView extends StatefulWidget {
  const _MessagesView({required this.apiClient});

  final UnifiedInboxApiClient apiClient;

  @override
  State<_MessagesView> createState() => _MessagesViewState();
}

class _MessagesViewState extends State<_MessagesView> {
  late Future<List<Envelope>> _messagesFuture;

  @override
  void initState() {
    super.initState();
    _messagesFuture = widget.apiClient.fetchMessages(limit: 100);
  }

  Future<void> _refresh() async {
    final nextFuture = widget.apiClient.fetchMessages(limit: 100);
    setState(() => _messagesFuture = nextFuture);
    await nextFuture;
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _refresh,
      child: _LoadableView<List<Envelope>>(
        future: _messagesFuture,
        builder: (context, envelopes) => ListView.separated(
          itemCount: envelopes.length,
          separatorBuilder: (_, _) => const Divider(height: 1),
          itemBuilder: (context, index) {
            final envelope = envelopes[index];
            return _MessageTile(envelope: envelope);
          },
        ),
        emptyBuilder: (context) => const _EmptyState(
          message: 'No messages yet. Connectors will surface messages here once configured.',
        ),
      ),
    );
  }
}

class _MessageTile extends StatelessWidget {
  const _MessageTile({required this.envelope});

  final Envelope envelope;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final unread = envelope.isUnread;
    return ListTile(
      leading: _SourceBadge(source: envelope.source),
      title: Text(
        envelope.sender?.label ?? envelope.conversationTitle ?? envelope.source,
        style: TextStyle(fontWeight: unread ? FontWeight.bold : FontWeight.normal),
      ),
      subtitle: Text(
        envelope.bodyText ?? '(no text)',
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text(
            _relativeTime(envelope.sentAt),
            style: theme.textTheme.bodySmall,
          ),
          if (unread)
            Container(
              margin: const EdgeInsets.only(top: 4),
              width: 8,
              height: 8,
              decoration: const BoxDecoration(color: Colors.indigo, shape: BoxShape.circle),
            ),
        ],
      ),
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => MessageDetailScreen(envelope: envelope)),
      ),
    );
  }
}

class _SourceBadge extends StatelessWidget {
  const _SourceBadge({required this.source});

  final String source;

  @override
  Widget build(BuildContext context) {
    final icon = _sourceIcon(source);
    return CircleAvatar(
      radius: 16,
      child: Icon(icon, size: 16),
    );
  }
}

IconData _sourceIcon(String source) {
  switch (source) {
    case 'email-imap':
      return Icons.email_outlined;
    case 'rss':
      return Icons.rss_feed;
    case 'discord':
      return Icons.forum_outlined;
    case 'telegram':
      return Icons.send_outlined;
    case 'matrix':
      return Icons.grid_view_outlined;
    case 'slack':
      return Icons.tag;
    case 'webhook':
      return Icons.webhook_outlined;
    case 'android-sms-mms':
      return Icons.sms_outlined;
    default:
      return Icons.inbox_outlined;
  }
}

String _relativeTime(DateTime timestamp) {
  final diff = DateTime.now().toUtc().difference(timestamp);
  if (diff.inMinutes < 1) return 'now';
  if (diff.inHours < 1) return '${diff.inMinutes}m';
  if (diff.inDays < 1) return '${diff.inHours}h';
  if (diff.inDays < 7) return '${diff.inDays}d';
  final local = timestamp.toLocal();
  return '${local.day}/${local.month}/${local.year}';
}

/// Read-only message detail. Shows every envelope field the backend reports,
/// plus attachment references as links. No reply/mark-read/delete actions.
class MessageDetailScreen extends StatelessWidget {
  const MessageDetailScreen({super.key, required this.envelope});

  final Envelope envelope;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(envelope.conversationTitle ?? 'Message')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _DetailRow(label: 'Source', value: envelope.source),
          _DetailRow(label: 'Account', value: envelope.accountRef),
          _DetailRow(label: 'From', value: envelope.sender?.label ?? 'unknown'),
          if (envelope.sender?.handle != null) _DetailRow(label: 'Handle', value: envelope.sender!.handle!),
          _DetailRow(label: 'Sent', value: envelope.sentAt.toLocal().toString()),
          _DetailRow(label: 'Received', value: envelope.receivedAt.toLocal().toString()),
          _DetailRow(label: 'State', value: envelope.readState),
          if (envelope.permalink != null) _DetailRow(label: 'Link', value: envelope.permalink!),
          const Divider(),
          const SizedBox(height: 8),
          Text(
            envelope.bodyText ?? '(no body)',
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          if (envelope.attachmentRefs.isNotEmpty) ...[
            const SizedBox(height: 24),
            Text('Attachments', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            ...envelope.attachmentRefs.map((ref) => ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.attach_file),
                  title: Text(ref.name ?? 'attachment'),
                  subtitle: ref.url != null ? Text(ref.url!, maxLines: 1, overflow: TextOverflow.ellipsis) : null,
                )),
          ],
        ],
      ),
    );
  }
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 96,
            child: Text(label, style: Theme.of(context).textTheme.labelMedium),
          ),
          Expanded(child: Text(value)),
        ],
      ),
    );
  }
}

class _ConversationsView extends StatelessWidget {
  const _ConversationsView({required this.apiClient});

  final UnifiedInboxApiClient apiClient;

  @override
  Widget build(BuildContext context) {
    return _LoadableView<List<Conversation>>(
      future: apiClient.fetchConversations(),
      builder: (context, conversations) => ListView.separated(
        itemCount: conversations.length,
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (context, index) {
          final conversation = conversations[index];
          return ListTile(
            leading: _SourceBadge(source: conversation.source),
            title: Text(conversation.conversationTitle ?? conversation.conversationId),
            subtitle: Text('${conversation.source} · ${conversation.accountRef}'),
            trailing: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text('${conversation.messageCount}', style: Theme.of(context).textTheme.titleMedium),
                if (conversation.latestSentAt != null)
                  Text(_relativeTime(conversation.latestSentAt!), style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
          );
        },
      ),
      emptyBuilder: (context) => const _EmptyState(message: 'No conversations yet.'),
    );
  }
}

class _StatusView extends StatelessWidget {
  const _StatusView({required this.apiClient});

  final UnifiedInboxApiClient apiClient;

  @override
  Widget build(BuildContext context) {
    return _LoadableView<InboxStatus>(
      future: apiClient.fetchStatus(),
      builder: (context, status) {
        final pending = status.connectors.where((c) => c.pendingCredentials).toList();
        final errors = status.connectors.where((c) => c.isErrorState).toList();
        final ok = status.connectors.where((c) => !c.pendingCredentials && !c.isErrorState).toList();
        return SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Card(
                child: ListTile(
                  leading: Icon(
                    status.isReadOnly ? Icons.lock_outline : Icons.warning_amber_outlined,
                    color: status.isReadOnly ? Colors.green : Colors.orange,
                  ),
                  title: Text(status.serviceName),
                  subtitle: Text('mode: ${status.serviceMode} · status: ${status.serviceStatus}'),
                  trailing: Text('${status.messageCount} msgs', style: Theme.of(context).textTheme.titleMedium),
                ),
              ),
              const SizedBox(height: 16),
              Text('Connectors', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              if (pending.isNotEmpty) ...[
                _PendingCredentialsCard(connectors: pending),
                const SizedBox(height: 8),
              ],
              if (errors.isNotEmpty) ...[
                _ConnectorGroup(
                  title: 'Errors',
                  color: Colors.red,
                  connectors: errors,
                ),
                const SizedBox(height: 8),
              ],
              if (ok.isNotEmpty)
                _ConnectorGroup(
                  title: 'Healthy',
                  color: Colors.green,
                  connectors: ok,
                ),
              if (status.connectors.isEmpty)
                const _EmptyState(message: 'No connector status reported.'),
              if (status.exclusions.isNotEmpty) ...[
                const SizedBox(height: 16),
                Text('Excluded', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                ...status.exclusions.map(
                  (exclusion) => ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.block),
                    title: Text(exclusion.source),
                    subtitle: exclusion.reason != null ? Text(exclusion.reason!) : null,
                  ),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

/// Banner for connectors that need credentials before they can surface data.
class _PendingCredentialsCard extends StatelessWidget {
  const _PendingCredentialsCard({required this.connectors});

  final List<ConnectorStatus> connectors;

  @override
  Widget build(BuildContext context) {
    return Card(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.key_outlined),
                const SizedBox(width: 8),
                Text('Credentials pending', style: Theme.of(context).textTheme.titleSmall),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              'The following connectors have no credentials configured yet and '
              'will surface messages once they are set up in Vaultwarden:',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 8),
            ...connectors.map(
              (c) => ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: _SourceBadge(source: c.source),
                title: Text(c.source),
                subtitle: c.detail != null ? Text(c.detail!) : null,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ConnectorGroup extends StatelessWidget {
  const _ConnectorGroup({required this.title, required this.color, required this.connectors});

  final String title;
  final Color color;
  final List<ConnectorStatus> connectors;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: Theme.of(context).textTheme.labelLarge?.copyWith(color: color)),
        ...connectors.map(
          (c) => ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: _SourceBadge(source: c.source),
            title: Text(c.source),
            subtitle: c.detail != null ? Text(c.detail!) : null,
            trailing: Text(c.state, style: TextStyle(color: color, fontSize: 12)),
          ),
        ),
      ],
    );
  }
}