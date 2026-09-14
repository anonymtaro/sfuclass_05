// classroom-app/server/src/classroom/Peer.js
/**
 * Peer  (F1)  [EXT]
 *
 * One person's presence in one room: their transports, what they are
 * publishing, what they are subscribed to, and their role.
 *
 * Extended in version 6 with `role` and a named producer map. The map is the
 * change that matters. Version 5 kept producers in a flat list, which was fine
 * while a peer could only send a camera and a microphone. A screen share is a
 * *second* video producer on the same peer, so "the video producer" stopped
 * being a meaningful phrase — `producers.camera` and `producers.screen` are
 * different things and the recorder, the layout and the moderation controls all
 * need to tell them apart.
 */

const PRODUCER_SLOTS = ['camera', 'microphone', 'screen', 'screenAudio'];

export class Peer {
  /**
   * @param {object} options
   * @param {string} options.id           socket id; unique within the room
   * @param {object} options.user         { userId, displayName, avatarUrl }
   * @param {'host'|'cohost'|'learner'} options.role
   */
  constructor({ id, user, role = 'learner', device = {} }) {
    this.id = id;
    this.user = user;
    this.role = role;
    this.device = device;

    this.transports = new Map();
    /** Named slots, not a list. See the note at the top of the file. */
    this.producers = { camera: null, microphone: null, screen: null, screenAudio: null };
    this.consumers = new Map();

    this.handRaised = false;
    this.handRaisedAt = null;
    /** Set while the peer is in a breakout rather than the main room. */
    this.breakoutId = null;
    /** False while the peer is in the waiting room. */
    this.admitted = true;

    this.joinedAt = new Date().toISOString();
    this.closed = false;
  }

  get isHost() {
    return this.role === 'host';
  }

  /** Hosts and cohosts share every moderation capability except being removed. */
  get canModerate() {
    return this.role === 'host' || this.role === 'cohost';
  }

  // -------------------------------------------------------------------------
  // Transports
  // -------------------------------------------------------------------------

  addTransport(transport, direction) {
    this.transports.set(transport.id, { transport, direction });
    return transport;
  }

  getTransport(transportId) {
    return this.transports.get(transportId)?.transport ?? null;
  }

  // -------------------------------------------------------------------------
  // Producers
  // -------------------------------------------------------------------------

  /**
   * @param {'camera'|'microphone'|'screen'|'screenAudio'} source
   */
  addProducer(source, producer) {
    if (!PRODUCER_SLOTS.includes(source)) {
      throw new Error(`unknown producer source: ${source}`);
    }

    // Replacing a slot closes the old one. A client that produces twice for
    // the same source — after switching camera, say — should not leave the
    // first producer alive and consuming bandwidth for every subscriber.
    this.producers[source]?.close();
    this.producers[source] = producer;

    producer.observer.once('close', () => {
      if (this.producers[source] === producer) this.producers[source] = null;
    });

    return producer;
  }

  findProducer(producerId) {
    return Object.values(this.producers).find((producer) => producer?.id === producerId) ?? null;
  }

  sourceOf(producerId) {
    return PRODUCER_SLOTS.find((slot) => this.producers[slot]?.id === producerId) ?? null;
  }

  closeProducer(source) {
    const producer = this.producers[source];
    if (!producer) return false;
    producer.close();
    this.producers[source] = null;
    return true;
  }

  /** Screen and screen audio go together; stopping one stops both. */
  closeScreenShare() {
    const closed = this.closeProducer('screen');
    this.closeProducer('screenAudio');
    return closed;
  }

  get isSharingScreen() {
    return Boolean(this.producers.screen && !this.producers.screen.closed);
  }

  get producerCount() {
    return Object.values(this.producers).filter((producer) => producer && !producer.closed).length;
  }

  // -------------------------------------------------------------------------
  // Consumers
  // -------------------------------------------------------------------------

  addConsumer(consumer) {
    this.consumers.set(consumer.id, consumer);
    consumer.observer.once('close', () => this.consumers.delete(consumer.id));
    return consumer;
  }

  consumersOfProducer(producerId) {
    return [...this.consumers.values()].filter((consumer) => consumer.producerId === producerId);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  close() {
    if (this.closed) return;
    this.closed = true;

    // Closing a transport closes its producers and consumers, so this is
    // enough — iterating the producers as well would double-close them.
    for (const { transport } of this.transports.values()) {
      try {
        transport.close();
      } catch {
        // Already gone with the router.
      }
    }
    this.transports.clear();
    this.consumers.clear();
    this.producers = { camera: null, microphone: null, screen: null, screenAudio: null };
  }

  /** Matches SignalingEvents.PeerSchema in @classroom/contracts. */
  toJSON() {
    return {
      peerId: this.id,
      user: {
        userId: this.user.userId,
        displayName: this.user.displayName,
        avatarUrl: this.user.avatarUrl ?? null,
      },
      role: this.role,
      handRaised: this.handRaised,
      producers: PRODUCER_SLOTS.filter((slot) => this.producers[slot])
        .map((slot) => ({
          producerId: this.producers[slot].id,
          peerId: this.id,
          userId: this.user.userId,
          kind: this.producers[slot].kind,
          source: slot === 'screenAudio' ? 'screen-audio' : slot,
          paused: this.producers[slot].paused,
        })),
      joinedAt: this.joinedAt,
      breakoutId: this.breakoutId,
    };
  }
}

export default Peer;