/**
 * apps/mobile/src/screens/ChatScreen.tsx [NEW]
 * conversations + public channel (F6)
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  Pressable,
  Image,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useChat, useUpload, type ChatTarget } from '@classroom/core-client';
import type { Message } from '@classroom/contracts';
import { pickChatAttachment } from '../native/filePicker';
import type { ScreenProps } from '../navigation/types';

export default function ChatScreen({ route }: ScreenProps<'Chat'>) {
  const { conversationId, channelId } = route.params;
  const target: ChatTarget = conversationId
    ? { kind: 'conversation', id: conversationId }
    : { kind: 'channel', id: channelId ?? 'public' };

  const { messages, loadingOlder, hasMoreOlder, typingUserIds, loadOlder, send, setTyping, markRead } =
    useChat(target);
  const { upload, uploading, progress } = useUpload();
  const [draft, setDraft] = useState('');

  const handleSend = useCallback(() => {
    const body = draft.trim();
    if (!body) return;
    send(body);
    setDraft('');
    setTyping(false);
  }, [draft, send, setTyping]);

  const handleChangeText = useCallback(
    (text: string) => {
      setDraft(text);
      setTyping(text.length > 0);
    },
    [setTyping],
  );

  const handleAttach = useCallback(async () => {
    const file = await pickChatAttachment();
    if (!file) return;
    const asset = await upload(file);
    send('', [
      {
        id: asset.id,
        assetId: asset.id,
        fileName: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        downloadUrl: asset.downloadUrl,
        previewUrl: asset.hlsUrl,
      },
    ]);
  }, [upload, send]);

  const typingLabel = useMemo(() => {
    if (typingUserIds.length === 0) return null;
    return typingUserIds.length === 1 ? 'schreibt …' : `${typingUserIds.length} schreiben …`;
  }, [typingUserIds]);

  const renderMessage = ({ item }: { item: Message }) => (
    <View style={[styles.bubble, item.senderId === 'me' ? styles.bubbleMine : styles.bubbleOther]}>
      {item.body.length > 0 && <Text style={styles.bubbleText}>{item.body}</Text>}
      {item.attachments.map((att) => (
        <View key={att.id} style={styles.attachmentTile}>
          {att.previewUrl ? (
            <Image source={{ uri: att.previewUrl }} style={styles.attachmentPreview} />
          ) : (
            <Text style={styles.attachmentName} numberOfLines={1}>
              📎 {att.fileName}
            </Text>
          )}
        </View>
      ))}
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <FlatList
        data={[...messages].reverse()}
        keyExtractor={(m) => m.dedupeKey}
        renderItem={renderMessage}
        inverted
        onScrollBeginDrag={markRead}
        onEndReached={() => {
          if (hasMoreOlder) void loadOlder();
        }}
        onEndReachedThreshold={0.3}
        contentContainerStyle={styles.list}
      />

      {typingLabel && <Text style={styles.typingIndicator}>{typingLabel}</Text>}
      {uploading && <Text style={styles.uploadIndicator}>Upload läuft … {Math.round(progress * 100)}%</Text>}
      {loadingOlder && <Text style={styles.uploadIndicator}>Ältere Nachrichten werden geladen …</Text>}

      <View style={styles.composer}>
        <Pressable style={styles.attachBtn} onPress={handleAttach}>
          <Text style={styles.attachIcon}>+</Text>
        </Pressable>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={handleChangeText}
          placeholder={target.kind === 'channel' ? 'An alle schreiben …' : 'Nachricht …'}
          multiline
        />
        <Pressable style={styles.sendBtn} onPress={handleSend} disabled={draft.trim().length === 0}>
          <Text style={styles.sendLabel}>Senden</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  list: { padding: 12 },
  bubble: { maxWidth: '78%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, marginVertical: 4 },
  bubbleMine: { alignSelf: 'flex-end', backgroundColor: '#4C6FFF' },
  bubbleOther: { alignSelf: 'flex-start', backgroundColor: '#F0F1F5' },
  bubbleText: { color: '#111', fontSize: 15 },
  attachmentTile: { marginTop: 6 },
  attachmentPreview: { width: 180, height: 120, borderRadius: 10 },
  attachmentName: { fontSize: 13, color: '#333' },
  typingIndicator: { paddingHorizontal: 16, paddingBottom: 4, fontSize: 12, color: '#888' },
  uploadIndicator: { paddingHorizontal: 16, paddingBottom: 4, fontSize: 12, color: '#4C6FFF' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', padding: 10, borderTopWidth: 1, borderTopColor: '#EEE' },
  attachBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#F0F1F5', alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  attachIcon: { fontSize: 18, color: '#4C6FFF', fontWeight: '700' },
  input: { flex: 1, maxHeight: 100, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, backgroundColor: '#F5F6F8', fontSize: 15 },
  sendBtn: { marginLeft: 8, paddingHorizontal: 14, paddingVertical: 8 },
  sendLabel: { color: '#4C6FFF', fontWeight: '600' },
});