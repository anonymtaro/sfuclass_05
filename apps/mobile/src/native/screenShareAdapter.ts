/**
 * apps/mobile/src/native/screenShareAdapter.ts
 * Thin wrapper so screens can check support / start / stop without importing
 * react-native-webrtc directly (F1).
 */
import { Platform } from 'react-native';
import { rtcAdapter } from './rtcAdapter';
import type { ScreenShareAdapter, LocalTrackHandle } from '@classroom/core-client';

export const screenShareAdapter: ScreenShareAdapter = {
  isSupported() {
    // iOS: ReplayKit broadcast extension must be configured in the app target.
    // Android: MediaProjection requires API 21+, which is the app's floor.
    return Platform.OS === 'ios' || Platform.OS === 'android';
  },
  async start(): Promise<LocalTrackHandle> {
    return rtcAdapter.getScreenShare();
  },
  async stop(handle: LocalTrackHandle): Promise<void> {
    rtcAdapter.stopTrack(handle);
  },
};