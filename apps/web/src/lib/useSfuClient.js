/**
 * Builds the SfuClient for one lesson  (F1)
 *
 * Lives in apps/web rather than in CoreProvider on purpose. A tab has one HTTP
 * client and one chat socket for its whole life; a lesson does not. Keeping the
 * media stack here means `mediasoup-client` is imported only from the lazy
 * classroom route, so somebody who never opens a lesson never downloads it —
 * which is the entire reason vite.config.ts gives `rtc` its own chunk.
 *
 * Everything this assembles already exists in @classroom/core-client. The three
 * browser implementations below are selected, not written:
 *
 *   createBrowserDeviceAdapter       camera, microphone, device enumeration
 *   createBrowserScreenShareAdapter  getDisplayMedia, including the browser's
 *                                    own stop bar
 *   createSocketClient               already implements SignalingTransport
 *
 * SfuClient takes a transport *factory*, not a transport: a rejoin after a node
 * drains throws the old socket away and builds a fresh one, and a factory is
 * what lets it do that without reaching back into this file.
 */

import { useEffect, useMemo } from 'react';
import { Device } from 'mediasoup-client';
import {
  SfuClient,
  createBrowserDeviceAdapter,
  createBrowserScreenShareAdapter,
  createSocketClient,
  useCore,
} from '@classroom/core-client';
import { SignalingEvents } from '@classroom/contracts';

export const useSfuClient = () => {
  const { getAccessToken, nodeResolver } = useCore();

  const deviceAdapter = useMemo(
    () => createBrowserDeviceAdapter({ DeviceCtor: Device, maxVideoHeight: 720 }),
    [],
  );

  const screenShareAdapter = useMemo(() => createBrowserScreenShareAdapter(), []);

  const sfu = useMemo(
    () =>
      new SfuClient({
        deviceAdapter,
        screenShareAdapter,
        nodeResolver,
        createTransport: () =>
          createSocketClient({
            namespace: SignalingEvents.CLASSROOM_NAMESPACE,
            getAccessToken,
            logger: import.meta.env.DEV ? console : undefined,
          }),
        getAccessToken,
        DeviceCtor: Device,
        logger: import.meta.env.DEV ? console : undefined,
        // Three attempts with backoff covers a rolling SFU replacement; beyond
        // that the room genuinely is not coming back and saying so is kinder
        // than retrying forever.
        rejoinAttempts: 3,
      }),
    [deviceAdapter, screenShareAdapter, nodeResolver, getAccessToken],
  );

  // A camera light still on after navigating away is the classic symptom of
  // forgetting this.
  useEffect(() => () => void sfu.leave().catch(() => {}), [sfu]);

  return { sfu, deviceAdapter, screenShareAdapter };
};

export default useSfuClient;