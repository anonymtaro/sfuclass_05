/**
 * useClassroom  (F1)
 *
 * Turns SfuClient's event stream into React state. It owns nothing: every
 * decision about media lives in SfuClient, and this hook only mirrors what
 * happened so a component can render it.
 *
 * That split is what lets apps/mobile reuse SfuClient with a completely
 * different view layer, and it is why the reducer here is deliberately dumb —
 * no business rules, only "the server said X, so state is now Y".
 *
 * Streams are kept in a Map keyed by consumerId rather than by peer, because a
 * single peer can be sending three tracks at once (camera, microphone, screen)
 * and the layout needs to address each independently.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SignalingEvents } from '@classroom/contracts';
import { ApiError } from '@classroom/contracts';
import type { MediaStreamTrackLike, DeviceAdapter } from '../rtc/DeviceAdapter.js';
import type { RemoteStream, SfuClient, SfuConnectionState } from '../rtc/SfuClient.js';

export interface ClassroomState {
  status: SfuConnectionState;
  roomId: string | null;
  selfPeerId: string | null;
  selfRole: SignalingEvents.PeerRole | null;
  peers: SignalingEvents.Peer[];
  streams: RemoteStream[];
  /** The active share, whoever is presenting. Null when nobody is. */
  screenShare: SignalingEvents.ScreenShareStarted | null;
  recording: boolean;
  waitingPeers: SignalingEvents.WaitingPeer[];
  cameraEnabled: boolean;
  microphoneEnabled: boolean;
  handRaised: boolean;
  error: ApiError | null;
}

export interface ClassroomActions {
  join(): Promise<void>;
  leave(): Promise<void>;
  toggleCamera(): Promise<void>;
  toggleMicrophone(): Promise<void>;
  switchCamera(): Promise<void>;
  raiseHand(raised: boolean): Promise<void>;
  react(emoji: string): Promise<void>;
  hostAction(
    payload: SignalingEvents.SignalingClientPayloads['classroom:host.action'],
  ): Promise<void>;
  admit(peerId: string): Promise<void>;
}

export interface UseClassroomOptions {
  sfu: SfuClient;
  deviceAdapter: DeviceAdapter;
  roomId: string;
  /** Join as soon as the component mounts. */
  autoJoin?: boolean;
  /** Start muted, which is the right default for anything above ten people. */
  startMuted?: boolean;
  startCameraOff?: boolean;
  onReaction?(event: { peerId: string; emoji: string }): void;
}

export interface UseClassroomResult extends ClassroomState {
  actions: ClassroomActions;
  /** Local camera track, for the self-view tile. */
  localVideoTrack: MediaStreamTrackLike | null;
}

export const useClassroom = (options: UseClassroomOptions): UseClassroomResult => {
  const { sfu, deviceAdapter, roomId, autoJoin = true, startMuted = false } = options;

  const [status, setStatus] = useState<SfuConnectionState>('idle');
  const [peers, setPeers] = useState<SignalingEvents.Peer[]>([]);
  const [streamMap, setStreamMap] = useState<Map<string, RemoteStream>>(new Map());
  const [screenShare, setScreenShare] = useState<SignalingEvents.ScreenShareStarted | null>(null);
  const [waitingPeers, setWaitingPeers] = useState<SignalingEvents.WaitingPeer[]>([]);
  const [recording, setRecording] = useState(false);
  const [selfPeerId, setSelfPeerId] = useState<string | null>(null);
  const [selfRole, setSelfRole] = useState<SignalingEvents.PeerRole | null>(null);
  const [cameraEnabled, setCameraEnabled] = useState(!options.startCameraOff);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(!startMuted);
  const [handRaised, setHandRaised] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const localVideoRef = useRef<MediaStreamTrackLike | null>(null);
  const joinedRef = useRef(false);

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  useEffect(() => {
    const unsubscribers = [
      sfu.on('stateChanged', setStatus),

      sfu.on('roomState', (state) => {
        setPeers(state.peers);
        setSelfPeerId(state.selfPeerId);
        setSelfRole(state.selfRole);
        setRecording(state.recording);
        setScreenShare(state.screenShare);
      }),

      sfu.on('peerJoined', (peer) => {
        setPeers((current) => [...current.filter((p) => p.peerId !== peer.peerId), peer]);
      }),

      sfu.on('peerUpdated', (peer) => {
        setPeers((current) => current.map((p) => (p.peerId === peer.peerId ? peer : p)));
      }),

      sfu.on('peerLeft', ({ peerId }) => {
        setPeers((current) => current.filter((p) => p.peerId !== peerId));
        // Their consumers are closed server-side, but dropping them here keeps
        // a dead tile from lingering for a frame.
        setStreamMap((current) => {
          const next = new Map(current);
          for (const [id, stream] of next) if (stream.peerId === peerId) next.delete(id);
          return next;
        });
      }),

      sfu.on('streamAdded', (stream) => {
        setStreamMap((current) => new Map(current).set(stream.consumerId, stream));
      }),

      sfu.on('streamRemoved', ({ consumerId }) => {
        setStreamMap((current) => {
          const next = new Map(current);
          next.delete(consumerId);
          return next;
        });
      }),

      sfu.on('screenShareStarted', setScreenShare),
      sfu.on('screenShareStopped', () => setScreenShare(null)),

      sfu.on('handRaised', ({ peerId, raised }) => {
        setPeers((current) =>
          current.map((p) => (p.peerId === peerId ? { ...p, handRaised: raised } : p)),
        );
      }),

      sfu.on('reaction', (event) => options.onReaction?.(event)),
      sfu.on('recordingChanged', ({ recording: isRecording }) => setRecording(isRecording)),
      sfu.on('error', setError),
      sfu.on('closed', () => {
        joinedRef.current = false;
        setPeers([]);
        setStreamMap(new Map());
        setScreenShare(null);
      }),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [sfu, options]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const join = useCallback(async () => {
    if (joinedRef.current) return;
    joinedRef.current = true;
    setError(null);

    try {
      await sfu.join(roomId);

      // Permissions and capture happen after the join, so a learner who denies
      // the camera still lands in the room and can watch.
      const stream = await deviceAdapter.getUserMedia({
        audio: true,
        video: !options.startCameraOff,
      });

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        await sfu.publishMicrophone(audioTrack);
        if (startMuted) await sfu.setMicrophoneEnabled(false);
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && !options.startCameraOff) {
        localVideoRef.current = videoTrack;
        await sfu.publishCamera(videoTrack);
      }
    } catch (cause) {
      joinedRef.current = false;
      setError(
        ApiError.is(cause)
          ? cause
          : new ApiError('internal_error', {
              detail: cause instanceof Error ? cause.message : 'Could not join the room',
            }),
      );
    }
  }, [sfu, deviceAdapter, roomId, startMuted, options.startCameraOff]);

  const leave = useCallback(async () => {
    joinedRef.current = false;
    localVideoRef.current = null;
    await sfu.leave();
  }, [sfu]);

  useEffect(() => {
    if (autoJoin) void join();
    return () => {
      void sfu.leave();
    };
  }, [autoJoin, join, sfu]);

  const toggleCamera = useCallback(async () => {
    const next = !cameraEnabled;
    setCameraEnabled(next);
    try {
      await sfu.setCameraEnabled(next);
    } catch (cause) {
      setCameraEnabled(!next); // put the button back where it was
      setError(ApiError.is(cause) ? cause : null);
    }
  }, [cameraEnabled, sfu]);

  const toggleMicrophone = useCallback(async () => {
    const next = !microphoneEnabled;
    setMicrophoneEnabled(next);
    try {
      await sfu.setMicrophoneEnabled(next);
    } catch (cause) {
      setMicrophoneEnabled(!next);
      setError(ApiError.is(cause) ? cause : null);
    }
  }, [microphoneEnabled, sfu]);

  const switchCamera = useCallback(async () => {
    const current = localVideoRef.current;
    if (!current || !deviceAdapter.capabilities.canSwitchCamera) return;
    const next = await deviceAdapter.switchCamera(current);
    localVideoRef.current = next;
    await sfu.publishCamera(next);
  }, [deviceAdapter, sfu]);

  const raiseHand = useCallback(
    async (raised: boolean) => {
      setHandRaised(raised);
      await sfu.raiseHand(raised);
    },
    [sfu],
  );

  const actions = useMemo<ClassroomActions>(
    () => ({
      join,
      leave,
      toggleCamera,
      toggleMicrophone,
      switchCamera,
      raiseHand,
      react: (emoji) => sfu.react(emoji),
      hostAction: (payload) => sfu.hostAction(payload),
      admit: async (peerId) => {
        await sfu.hostAction({ targetPeerId: peerId, action: 'admit' });
        setWaitingPeers((current) => current.filter((p) => p.peerId !== peerId));
      },
    }),
    [join, leave, toggleCamera, toggleMicrophone, switchCamera, raiseHand, sfu],
  );

  const streams = useMemo(() => [...streamMap.values()], [streamMap]);

  return {
    status,
    roomId,
    selfPeerId,
    selfRole,
    peers,
    streams,
    screenShare,
    recording,
    waitingPeers,
    cameraEnabled,
    microphoneEnabled,
    handRaised,
    error,
    actions,
    localVideoTrack: localVideoRef.current,
  };
};