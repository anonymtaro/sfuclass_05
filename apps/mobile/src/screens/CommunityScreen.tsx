/**
 * apps/mobile/src/screens/CommunityScreen.tsx
 * (F2)
 */
import React from 'react';
import { View, Text, FlatList, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { useCommunity } from '@classroom/core-client';
import type { Thread } from '@classroom/contracts';
import type { ScreenProps } from '../navigation/types';

export default function CommunityScreen({ route }: ScreenProps<'Community'>) {
  const { spaceId } = route.params;
  const { space, threads, loading, loadingMore, hasMore, error, loadMore, refresh } =
    useCommunity(spaceId);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error || !space) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error ?? 'Space konnte nicht geladen werden.'}</Text>
      </View>
    );
  }

  const renderThread = ({ item }: { item: Thread }) => (
    <Pressable style={styles.threadRow}>
      <Text style={styles.threadTitle} numberOfLines={1}>
        {item.title}
      </Text>
      <View style={styles.threadMetaRow}>
        <Text style={styles.threadMeta}>{item.postCount} Beiträge</Text>
        <Text style={styles.threadMeta}>{formatRelative(item.lastActivityAt)}</Text>
      </View>
    </Pressable>
  );

  return (
    <View style={styles.container}>
      <Text style={styles.header}>{space.title}</Text>
      <FlatList
        data={threads}
        keyExtractor={(t) => t.id}
        renderItem={renderThread}
        onRefresh={refresh}
        refreshing={loading}
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (hasMore) void loadMore();
        }}
        ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.footerSpinner} /> : null}
        ListEmptyComponent={<Text style={styles.emptyText}>Noch keine Threads in diesem Space.</Text>}
      />
    </View>
  );
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const hours = Math.round(diffMs / 3_600_000);
  if (hours < 1) return 'gerade eben';
  if (hours < 24) return `vor ${hours} Std.`;
  return `vor ${Math.round(hours / 24)} Tg.`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: '#B3261E' },
  header: { fontSize: 20, fontWeight: '700', padding: 16, borderBottomWidth: 1, borderBottomColor: '#EEE' },
  threadRow: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  threadTitle: { fontSize: 15, fontWeight: '600' },
  threadMetaRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  threadMeta: { fontSize: 12, color: '#888' },
  footerSpinner: { paddingVertical: 16 },
  emptyText: { textAlign: 'center', color: '#888', marginTop: 40 },
});