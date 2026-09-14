// classroom-app/server/src/classroom/Room.js
/**
 * Room  (F1)  [EXT]
 *
 * One live session: a mediasoup router, the peers on it, and the state that
 * belongs to the session rather than to any one person.
 *
 * Extended in version 6 with three fields:
 *
 *   lessonId       links the room back to the curriculum, so a live lesson can
 *                  be opened from a course and its recording filed against it
 *   mode           lecture | seminar | office-hours — decides defaults, not
 *                  capabilities: whether learners arrive muted, whether the
 *                  waiting room is on
 *   breakoutParent set on a child room, so a breakout knows where to send its
 *                  people back to
 *
 * The room does not talk to sockets directly. It is given an `emit` function at
 * construction and calls that, which is what keeps this file testable without a
 * socket server and stops a circular import with signaling/.
 */

const MODE_DEFAULTS = {
  lecture: { startMuted: true, waitingRoom: true, learnersMayShare: false },
  seminar: { startMuted: false, waitingRoom: false, learnersMayShare: true },
  'office-hours': { startMuted: false, waitingRoom: true, learnersMayShare: true },
};

export class Room {
  constructor({
    id,
    router,
    worker,
    lessonId = null,
    mode = 'seminar',
    hostUserId = null,
    breakoutParent = null,
    emit = () => {},
  }) {
    this.id = id;
    this.router = router;
    this.worker = worker;
    this.lessonId = lessonId;
    this.mode = mode;
    this.hostUserId = hostUserId;
    /** Null for a main room; the parent room's id for a breakout. */
    this.breakoutParent = breakoutParent;
    /** Child rooms, while breakouts are open. */
    this.breakouts = new Map();

    this.settings = { ...MODE_DEFAULTS[mode] ?? MODE_DEFAULTS.seminar };
    this.peers = new Map();
    /** Peers who have knocked but not been admitted. */
    this.waiting = new Map();

    this.locked = false;
    this.recording = false;
    this.closed = false;
    this.createdAt = new Date().toISOString();

    this.emit = emit;
    this.activeSpeakerPeerId = null;
    this.audioLevelObserver = null;
  }

  get isBreakout() {
    return this.breakoutParent !== null;
  }

  get peerCount() {
    return this.peers.size;
  }

  get producerCount() {
    let total = 0;
    for (const peer of this.peers.values()) total += peer.producerCount;
    return total;
  }

  // -------------------------------------------------------------------------
  // Active speaker
  // -------------------------------------------------------------------------

  /**
   * mediasoup can tell us who is talking. Used for the recording source and
   * for the speaker tile; a room without an observer simply reports null,
   * which every caller already handles.
   */
  async startAudioLevelObserver() {
    if (!this.router.createAudioLevelObserver) return null;

    this.audioLevelObserver = await this.router.createAudioLevelObserver({
      maxEntries: 1,
      // Below this is breathing and keyboard noise, not speech.
      threshold: -55,
      interval: 800,
    });

    this.audioLevelObserver.on('volumes', ([volume]) => {
      const peerId = volume?.producer?.appData?.peerId ?? null;
      if (peerId === this.activeSpeakerPeerId) return;
      this.activeSpeakerPeerId = peerId;
      this.emit('classroom:peer.updated', this.getPeer(peerId)?.toJSON());
    });

    this.audioLevelObserver.on('silence', () => {
      this.activeSpeakerPeerId = null;
    });

    return this.audioLevelObserver;
  }

  getActiveSpeaker() {
    return this.activeSpeakerPeerId ? this.getPeer(this.activeSpeakerPeerId) : null;
  }

  // -------------------------------------------------------------------------
  // Peers
  // -------------------------------------------------------------------------

  addPeer(peer) {
    this.peers.set(peer.id, peer);
    if (peer.producers.microphone) this.#watchAudio(peer.producers.microphone, peer.id);
    return peer;
  }

  #watchAudio(producer, peerId) {
    producer.appData = { ...producer.appData, peerId };
    this.audioLevelObserver?.addProducer({ producerId: producer.id }).catch(() => undefined);
  }

  getPeer(peerId) {
    return this.peers.get(peerId) ?? null;
  }

  findPeerByUser(userId) {
    return [...this.peers.values()].find((peer) => peer.user.userId === userId) ?? null;
  }

  removePeer(peerId, reason = 'left') {
    const peer = this.peers.get(peerId);
    if (!peer) return null;

    peer.close();
    this.peers.delete(peerId);
    this.emit('classroom:peer.left', { peerId, reason });

    return peer;
  }

  listPeers() {
    return [...this.peers.values()].map((peer) => peer.toJSON());
  }

  // -------------------------------------------------------------------------
  // Producers
  // -------------------------------------------------------------------------

  /**
   * First producer matching a source across every peer. `{ source: 'screen' }`
   * is how the recorder and the layout find the active share.
   */
  findProducer({ source, peerId } = {}) {
    for (const peer of this.peers.values()) {
      if (peerId && peer.id !== peerId) continue;
      const producer = peer.producers[source];
      if (producer && !producer.closed) return producer;
    }
    return null;
  }

  /** Used by the recording pipeline, which records the host's audio. */
  getHostProducer(source) {
    const host = [...this.peers.values()].find((peer) => peer.isHost);
    return host?.producers[source] ?? null;
  }

  producerOwner(producerId) {
    for (const peer of this.peers.values()) {
      if (peer.findProducer(producerId)) return peer;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  /** @param {{ except?: string }} options */
  broadcast(event, payload, { except } = {}) {
    this.emit(event, payload, { roomId: this.id, except });
  }

  sendTo(peerId, event, payload) {
    this.emit(event, payload, { roomId: this.id, only: peerId });
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** Matches SignalingEvents.RoomStateSchema. */
  toState(selfPeerId) {
    const self = this.getPeer(selfPeerId);
    const screenPeer = [...this.peers.values()].find((peer) => peer.isSharingScreen);

    return {
      roomId: this.id,
      lessonId: this.lessonId,
      mode: this.mode,
      routerRtpCapabilities: this.router.rtpCapabilities,
      peers: this.listPeers(),
      selfPeerId,
      selfRole: self?.role ?? 'learner',
      recording: this.recording,
      screenShare: screenPeer
        ? {
            peerId: screenPeer.id,
            user: screenPeer.toJSON().user,
            producerId: screenPeer.producers.screen.id,
            audioProducerId: screenPeer.producers.screenAudio?.id ?? null,
            label: screenPeer.producers.screen.appData?.label ?? null,
            startedAt: screenPeer.producers.screen.appData?.startedAt ?? this.createdAt,
          }
        : null,
      waitingRoomEnabled: this.settings.waitingRoom,
      startedAt: this.createdAt,
    };
  }

  stats() {
    return {
      roomId: this.id,
      lessonId: this.lessonId,
      mode: this.mode,
      peers: this.peerCount,
      producers: this.producerCount,
      waiting: this.waiting.size,
      breakouts: this.breakouts.size,
      recording: this.recording,
      locked: this.locked,
      isBreakout: this.isBreakout,
      createdAt: this.createdAt,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  close(reason = 'ended-by-host') {
    if (this.closed) return;
    this.closed = true;

    // Tell people before the transports die, or their clients learn about it
    // by timeout instead.
    this.broadcast('classroom:room.closed', { reason, reconnectNodeId: null });

    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.waiting.clear();

    try {
      this.audioLevelObserver?.close();
      if (!this.router.closed) this.router.close();
    } catch {
      // The router may already be gone with its worker.
    }
  }
}

export default Room;