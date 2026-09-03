import 'package:flutter_test/flutter_test.dart';
import 'package:unified_inbox_mobile/src/models.dart';

import 'fixtures.dart';

void main() {
  group('Envelope.fromJson', () {
    test('parses a full envelope with sender and attachments', () {
      final envelope = Envelope.fromJson(fixtureEnvelope());

      expect(envelope.source, 'discord');
      expect(envelope.accountRef, 'home-server-bot');
      expect(envelope.conversationId, 'conv-123');
      expect(envelope.conversationTitle, 'general');
      expect(envelope.threadId, 'thread-9');
      expect(envelope.messageId, 'msg-1');
      expect(envelope.sender, isNotNull);
      expect(envelope.sender!.label, 'Alice');
      expect(envelope.sender!.handle, 'alice#1234');
      expect(envelope.sentAt.isUtc, isTrue);
      expect(envelope.readState, 'unread');
      expect(envelope.isUnread, isTrue);
      expect(envelope.attachmentRefs, hasLength(1));
      expect(envelope.attachmentRefs.first.name, 'image.png');
      expect(envelope.attachmentRefs.first.url, 'https://cdn.example/a.png');
      expect(envelope.permalink, 'https://discord.com/channels/1/2/3');
    });

    test('parses a message with null optional fields', () {
      final raw = fixtureEnvelope()
        ..['sender'] = null
        ..['conversation_title'] = null
        ..['thread_id'] = null
        ..['attachment_refs'] = null
        ..['permalink'] = null;
      final envelope = Envelope.fromJson(raw);

      expect(envelope.sender, isNull);
      expect(envelope.conversationTitle, isNull);
      expect(envelope.attachmentRefs, isEmpty);
      expect(envelope.permalink, isNull);
    });

    test('falls back to unknown for a bad read_state', () {
      final raw = fixtureEnvelope()..['read_state'] = 'mutated';
      expect(Envelope.fromJson(raw).readState, 'unknown');
    });

    test('read states are restricted to the canonical set', () {
      expect(readStates, containsAll(['unknown', 'unread', 'read']));
    });

    test('sender label falls back through display name, handle, id', () {
      expect(const Sender(displayName: 'a', handle: 'h', id: 'i').label, 'a');
      expect(const Sender(displayName: null, handle: 'h', id: 'i').label, 'h');
      expect(const Sender(displayName: null, handle: null, id: 'i').label, 'i');
      expect(const Sender().label, 'unknown');
    });
  });

  group('Conversation.fromJson', () {
    test('parses conversation summaries', () {
      final conversation = Conversation.fromJson(fixtureConversation());
      expect(conversation.source, 'discord');
      expect(conversation.conversationId, 'conv-123');
      expect(conversation.messageCount, 3);
      expect(conversation.latestSentAt, isNotNull);
    });
  });

  group('InboxStatus.fromJson', () {
    test('parses status with connectors and exclusions', () {
      final status = InboxStatus.fromJson(fixtureStatus());
      expect(status.isReadOnly, isTrue);
      expect(status.serviceMode, 'read_only');
      expect(status.messageCount, 12);
      expect(status.connectors, hasLength(4));
      expect(status.exclusions, hasLength(2));
    });

    test('flags pending-credential connector states', () {
      final status = InboxStatus.fromJson(fixtureStatus());
      final pending = status.connectors.where((c) => c.pendingCredentials).toList();
      expect(pending.map((c) => c.source), containsAll(['discord', 'telegram']));
    });

    test('identifies error connector states separately from pending', () {
      final status = InboxStatus.fromJson(fixtureStatus());
      final errors = status.connectors.where((c) => c.isErrorState).toList();
      expect(errors.map((c) => c.source), ['rss']);
    });
  });
}