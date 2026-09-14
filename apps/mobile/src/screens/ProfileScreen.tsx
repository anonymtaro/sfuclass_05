/**
 * apps/mobile/src/screens/ProfileScreen.tsx [NEW]
 * profile → message CTA (F6)
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Image, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { apiRequest, openOrCreateDirect, usePresence } from '@classroom/core-client';
import type { Profile } from '@classroom/contracts';
import type { ScreenProps } from '../navigation/types';

export default function ProfileScreen({ route, navigation }: ScreenProps<'Profile'>) {
  const { userId } = route.params;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const presence = usePresence(profile ? [profile.userId] : []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiRequest<Profile>(`/profiles/${userId}`)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // ConversationService.openOrCreateDirect(a, b) — idempotent, no separate
  // "new message" flow to keep in sync (F6).
  const handleMessage = useCallback(async () => {
    if (!profile) return;
    setOpening(true);
    try {
      const conversation = await openOrCreateDirect(profile.userId);
      navigation.navigate('Chat', { conversationId: conversation.id });
    } finally {
      setOpening(false);
    }
  }, [profile, navigation]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Profil nicht gefunden.</Text>
      </View>
    );
  }

  const canMessage = profile.dmPolicy !== 'nobody';
  const status = presence[profile.userId] ?? 'offline';

  return (
    <View style={styles.container}>
      <View style={styles.avatarWrap}>
        {profile.avatarUrl ? (
          <Image source={{ uri: profile.avatarUrl }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarPlaceholder]}>
            <Text style={styles.avatarInitial}>{profile.displayName.charAt(0).toUpperCase()}</Text>
          </View>
        )}
        <View style={[styles.statusDot, statusColor(status)]} />
      </View>

      <Text style={styles.name}>{profile.displayName}</Text>
      <Text style={styles.role}>{roleLabel(profile.role)}</Text>
      {profile.bio && <Text style={styles.bio}>{profile.bio}</Text>}

      {canMessage ? (
        <Pressable style={styles.messageBtn} onPress={handleMessage} disabled={opening}>
          <Text style={styles.messageBtnLabel}>{opening ? 'Öffne Chat …' : 'Nachricht senden'}</Text>
        </Pressable>
      ) : (
        <Text style={styles.dmDisabled}>Diese Person nimmt aktuell keine Direktnachrichten an.</Text>
      )}
    </View>
  );
}

function roleLabel(role: Profile['role']): string {
  switch (role) {
    case 'owner':
      return 'Inhaber:in';
    case 'teacher':
      return 'Lehrkraft';
    default:
      return 'Lernende:r';
  }
}

function statusColor(status: string) {
  switch (status) {
    case 'online':
      return { backgroundColor: '#2ECC71' };
    case 'in-class':
      return { backgroundColor: '#4C6FFF' };
    case 'away':
      return { backgroundColor: '#F5A623' };
    default:
      return { backgroundColor: '#CCC' };
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', paddingTop: 48, backgroundColor: '#fff' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: '#B3261E' },
  avatarWrap: { position: 'relative' },
  avatar: { width: 96, height: 96, borderRadius: 48 },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF1FF' },
  avatarInitial: { fontSize: 32, fontWeight: '700', color: '#4C6FFF' },
  statusDot: { position: 'absolute', bottom: 4, right: 4, width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: '#fff' },
  name: { fontSize: 20, fontWeight: '700', marginTop: 14 },
  role: { fontSize: 13, color: '#888', marginTop: 2 },
  bio: { fontSize: 14, color: '#444', textAlign: 'center', marginTop: 12, paddingHorizontal: 32 },
  messageBtn: { marginTop: 24, backgroundColor: '#4C6FFF', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24 },
  messageBtnLabel: { color: '#fff', fontWeight: '600' },
  dmDisabled: { marginTop: 24, fontSize: 12, color: '#999', textAlign: 'center', paddingHorizontal: 32 },
});