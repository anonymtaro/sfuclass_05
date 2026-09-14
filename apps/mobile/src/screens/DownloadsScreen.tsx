/**
 * apps/mobile/src/screens/DownloadsScreen.tsx
 * offline lessons (F4)
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, Pressable, Alert, StyleSheet } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { apiRequest } from '@classroom/core-client';
import type { Asset, DownloadedLesson } from '@classroom/contracts';
import { playOfflineLesson, stopOfflinePlayback } from '../native/backgroundAudio';

const OFFLINE_DIR = `${FileSystem.documentDirectory}offline-lessons/`;
const MANIFEST_PATH = `${OFFLINE_DIR}manifest.json`;

export default function DownloadsScreen() {
  const [lessons, setLessons] = useState<DownloadedLesson[]>([]);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const loadManifest = useCallback(async () => {
    await FileSystem.makeDirectoryAsync(OFFLINE_DIR, { intermediates: true }).catch(() => {});
    const info = await FileSystem.getInfoAsync(MANIFEST_PATH);
    if (!info.exists) {
      setLessons([]);
      return;
    }
    const raw = await FileSystem.readAsStringAsync(MANIFEST_PATH);
    setLessons(JSON.parse(raw) as DownloadedLesson[]);
  }, []);

  useEffect(() => {
    void loadManifest();
  }, [loadManifest]);

  const saveManifest = useCallback(async (next: DownloadedLesson[]) => {
    await FileSystem.writeAsStringAsync(MANIFEST_PATH, JSON.stringify(next));
    setLessons(next);
  }, []);

  // Downloading a new lesson is driven from CourseScreen ("make available offline");
  // this screen also exposes it directly for a lessonId the user already knows about.
  const downloadLesson = useCallback(
    async (lessonId: string, courseId: string, title: string) => {
      setDownloadingId(lessonId);
      setDownloadProgress(0);
      try {
        const asset = await apiRequest<Asset>(`/media/lessons/${lessonId}/download-manifest`);
        if (!asset.downloadUrl) throw new Error('Lesson hat keine herunterladbare Datei.');

        const localUri = `${OFFLINE_DIR}${lessonId}.mp4`;
        const download = FileSystem.createDownloadResumable(
          asset.downloadUrl,
          localUri,
          {},
          (p) => setDownloadProgress(p.totalBytesWritten / p.totalBytesExpectedToWrite),
        );
        const result = await download.downloadAsync();
        if (!result) throw new Error('Download fehlgeschlagen.');

        const entry: DownloadedLesson = {
          lessonId,
          courseId,
          title,
          localUri: result.uri,
          sizeBytes: asset.sizeBytes,
          downloadedAt: new Date().toISOString(),
        };
        await saveManifest([...lessons.filter((l) => l.lessonId !== lessonId), entry]);
      } catch (e) {
        Alert.alert('Download fehlgeschlagen', e instanceof Error ? e.message : 'Unbekannter Fehler');
      } finally {
        setDownloadingId(null);
      }
    },
    [lessons, saveManifest],
  );

  const removeLesson = useCallback(
    async (entry: DownloadedLesson) => {
      await FileSystem.deleteAsync(entry.localUri, { idempotent: true });
      await saveManifest(lessons.filter((l) => l.lessonId !== entry.lessonId));
    },
    [lessons, saveManifest],
  );

  const togglePlay = useCallback(
    async (entry: DownloadedLesson) => {
      if (playingId === entry.lessonId) {
        await stopOfflinePlayback();
        setPlayingId(null);
        return;
      }
      await playOfflineLesson(entry.localUri, (status) => {
        if ('didJustFinish' in status && status.didJustFinish) setPlayingId(null);
      });
      setPlayingId(entry.lessonId);
    },
    [playingId],
  );

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Offline verfügbar</Text>
      {downloadingId && (
        <Text style={styles.progressText}>
          Lädt herunter … {Math.round(downloadProgress * 100)}%
        </Text>
      )}
      <FlatList
        data={lessons}
        keyExtractor={(l) => l.lessonId}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowInfo}>
              <Text style={styles.lessonTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.lessonMeta}>{formatSize(item.sizeBytes)}</Text>
            </View>
            <Pressable style={styles.iconBtn} onPress={() => togglePlay(item)}>
              <Text style={styles.iconLabel}>{playingId === item.lessonId ? '⏸' : '▶'}</Text>
            </Pressable>
            <Pressable style={styles.iconBtn} onPress={() => removeLesson(item)}>
              <Text style={styles.iconLabel}>🗑</Text>
            </Pressable>
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            Noch keine Lektion offline verfügbar. Lade eine Lektion in einem Kurs herunter.
          </Text>
        }
      />
    </View>
  );
}

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: { fontSize: 20, fontWeight: '700', padding: 16 },
  progressText: { paddingHorizontal: 16, paddingBottom: 8, fontSize: 12, color: '#4C6FFF' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  rowInfo: { flex: 1 },
  lessonTitle: { fontSize: 15, fontWeight: '500' },
  lessonMeta: { fontSize: 12, color: '#888', marginTop: 2 },
  iconBtn: { paddingHorizontal: 10, paddingVertical: 6 },
  iconLabel: { fontSize: 18 },
  emptyText: { textAlign: 'center', color: '#888', marginTop: 40, paddingHorizontal: 32 },
});