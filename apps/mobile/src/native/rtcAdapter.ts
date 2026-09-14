/**
 * apps/mobile/src/native/rtcAdapter.ts
 * implements DeviceAdapter (F1, F5)
 */
import { mediaDevices, MediaStream, MediaStreamTrack } from 'react-native-webrtc';
import type { DeviceAdapter, LocalTrackHandle, RemoteTrackHandle } from '@classroom/core-client';

const activeStreams = new Map<string, MediaStream>();

export const rtcAdapter: DeviceAdapter = {
  async getCamAndMic({ cam, mic }) {
    const stream = await mediaDevices.getUserMedia({ video: cam, audio: mic });
    const handles: LocalTrackHandle[] = [];
    stream.getTracks().forEach((track: MediaStreamTrack) => {
      const kind = track.kind === 'video' ? 'cam' : 'mic';
      activeStreams.set(track.id, stream);
      handles.push({
        kind,
        trackId: track.id,
        stop: () => {
          track.stop();
          activeStreams.delete(track.id);
        },
      });
    });
    return handles;
  },

  async getScreenShare() {
    // react-native-webrtc bridges getDisplayMedia to the native broadcast
    // extension (ReplayKit on iOS) / MediaProjection (Android) behind the scenes.
    const stream = await mediaDevices.getDisplayMedia({});
    const track = stream.getVideoTracks()[0];
    activeStreams.set(track.id, stream);
    return {
      kind: 'screen',
      trackId: track.id,
      stop: () => {
        track.stop();
        activeStreams.delete(track.id);
      },
    };
  },

  stopTrack(handle: LocalTrackHandle) {
    handle.stop();
  },

  attachRemoteTrack(_handle: RemoteTrackHandle) {
    // Rendering is done via RTCView bound to the SFU consumer's stream in
    // the component tree (ClassroomScreen tile), nothing to do centrally here.
  },

  detachRemoteTrack(_handle: RemoteTrackHandle) {
    // No-op: tile unmount releases the RTCView reference.
  },
};