// classroom-app/server/src/mediasoup/createWebRtcTransport.js
/**
 * WebRTC transport creation  (F1)  [UNCHANGED]
 *
 * Reference implementation, unchanged in behaviour from version 5. Keep yours
 * if it differs.
 *
 * Each peer gets two transports: one to send on, one to receive on. Splitting
 * them means a peer that publishes nothing still receives, and a congested
 * upstream does not throttle the downstream.
 *
 * The returned object is exactly what the client needs to build its side, and
 * nothing more — no internal ids, no server addresses beyond the announced one.
 */

import { webRtcTransportOptions } from '../config/mediasoup.config.js';
import { getAnnouncedIp } from '../config/announcedIp.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'transport' });

/** Ceiling per receiving transport. The room decides how it is shared. */
const MAX_INCOMING_BITRATE = 1_500_000;

export const createWebRtcTransport = async (router, { direction, forceRelay = false } = {}) => {
  const announcedAddress = getAnnouncedIp();

  const transport = await router.createWebRtcTransport({
    ...webRtcTransportOptions,
    listenInfos: webRtcTransportOptions.listenInfos.map((info) => ({
      ...info,
      announcedAddress,
    })),
    // A client that has already failed a direct connection asks for relay only,
    // which skips the ICE attempts it knows will fail.
    iceConsentTimeout: 30,
    ...(forceRelay ? { enableUdp: false, enableTcp: true, preferUdp: false } : {}),
    appData: { direction },
  });

  if (direction === 'recv') {
    try {
      await transport.setMaxIncomingBitrate(MAX_INCOMING_BITRATE);
    } catch (cause) {
      // Not fatal: the transport works, it is merely uncapped.
      log.warn({ err: cause }, 'could not set the incoming bitrate cap');
    }
  }

  transport.on('dtlsstatechange', (dtlsState) => {
    if (dtlsState === 'failed' || dtlsState === 'closed') {
      log.debug({ transportId: transport.id, dtlsState }, 'dtls ended');
      transport.close();
    }
  });

  transport.on('icestatechange', (iceState) => {
    // 'disconnected' is often temporary — a network change on a phone — so it
    // is logged and not acted on. 'closed' is final.
    if (iceState === 'disconnected') {
      log.debug({ transportId: transport.id }, 'ice disconnected');
    }
  });

  return {
    transport,
    /** The client-facing half. Nothing internal crosses this boundary. */
    params: {
      transportId: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters,
    },
  };
};

export default createWebRtcTransport;