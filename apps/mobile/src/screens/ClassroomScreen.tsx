/**
 * apps/mobile/src/screens/ClassroomScreen.tsx
 * react-native-webrtc (F1)
 */
import React, { useCallback } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { useClassroom } from '@classroom/core-client';
import type { Peer } from '@classroom/contracts';
import { rtcAdapter } from '../native/rtcAdapter';
import { screenShareAdapter } from '../native/screenShareAdapter';
import type { ScreenProps } from '../navigation/types';

export default function ClassroomScreen({ route, navigation }: ScreenProps<'Classroom'>) {
  const { roomId } = route.params;
  const { state, localTracks, toggleCam, toggleMic, startScreenShare, stopScreenShare, leave } =
    useClassroom({ roomId, deviceAdapter: rtcAdapter });

  const isSharing = localTracks.some((t) => t.kind === 'screen');
  const someoneElseSharing =
    !!state.activeScreenShareePeerId && state.activeScreenShareePeerId !== state.localPeerId;

  const handleShareToggle = useCallback(async () => {
    if (isSharing) {
      await stopScreenShare();
    } else if (screenShareAdapter.isSupported()) {
      await startScreenShare();
    }
  }, [isSharing, startScreenShare, stopScreenShare]);

  const handleLeave = useCallback(() => {
    leave();
    navigation.goBack();
  }, [leave, navigation]);

  const renderPeer = ({ item }: { item: Peer }) => (
    <View style={styles.tile}>
      {item.hasCam ? (
        <RTCView streamURL={`peer:${item.id}:cam`} style={styles.videoFill} objectFit="cover" />
      ) : (
        <View style={[styles.videoFill, styles.avatarPlaceholder]}>
          <Text style={styles.avatarInitial}>{item.displayName.charAt(0).toUpperCase()}</Text>
        </View>
      )}
      <Text style={styles.peerName} numberOfLines={1}>
        {item.displayName}
        {item.isSpeaking ? ' •' : ''}
      </Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.stage}>
        {state.activeScreenShareePeerId ? (
          <RTCView
            streamURL={`peer:${state.activeScreenShareePeerId}:screen`}
            style={styles.stageVideo}
            objectFit="contain"
          />
        ) : (
          <FlatList
            data={state.peers}
            keyExtractor={(p) => p.id}
            renderItem={renderPeer}
            numColumns={2}
            contentContainerStyle={styles.grid}
          />
        )}
      </View>

      {state.connectionState !== 'connected' && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            {state.connectionState === 'connecting' ? 'Verbinde …' : 'Verbindung wird wiederhergestellt …'}
          </Text>
        </View>
      )}

      <View style={styles.controls}>
        <Pressable style={styles.controlBtn} onPress={toggleMic}>
          <Text style={styles.controlLabel}>Mic</Text>
        </Pressable>
        <Pressable style={styles.controlBtn} onPress={toggleCam}>
          <Text style={styles.controlLabel}>Cam</Text>
        </Pressable>
        <Pressable
          style={[styles.controlBtn, someoneElseSharing && !isSharing && styles.controlBtnDisabled]}
          onPress={handleShareToggle}
          disabled={someoneElseSharing && !isSharing}
        >
          <Text style={styles.controlLabel}>{isSharing ? 'Teilen stoppen' : 'Bildschirm teilen'}</Text>
        </Pressable>
        <Pressable style={[styles.controlBtn, styles.leaveBtn]} onPress={handleLeave}>
          <Text style={styles.controlLabel}>Verlassen</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0E14' },
  stage: { flex: 1 },
  stageVideo: { flex: 1, backgroundColor: '#000' },
  grid: { padding: 8 },
  tile: { flex: 1, aspectRatio: 1, margin: 4, borderRadius: 12, overflow: 'hidden', backgroundColor: '#1A1F2B' },
  videoFill: { flex: 1 },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#2A3142' },
  avatarInitial: { color: '#fff', fontSize: 28, fontWeight: '600' },
  peerName: { position: 'absolute', bottom: 6, left: 8, color: '#fff', fontSize: 12 },
  banner: { position: 'absolute', top: 12, alignSelf: 'center', backgroundColor: '#00000099', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  bannerText: { color: '#fff', fontSize: 12 },
  controls: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 14, backgroundColor: '#131722' },
  controlBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, backgroundColor: '#232A3B' },
  controlBtnDisabled: { opacity: 0.4 },
  leaveBtn: { backgroundColor: '#B3261E' },
  controlLabel: { color: '#fff', fontSize: 13, fontWeight: '500' },
});