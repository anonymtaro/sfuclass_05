// classroom-app/server/src/classroom/RoomRegistry.js
/**
 * Room to node mapping  (F1)  [UNCHANGED]
 *
 * Reference implementation; keep yours if it differs. Version 6 adds one
 * requirement, marked below: `markNodeDraining`, called by lifecycle/drainSfu.js.
 *
 * A room lives on exactly one SFU node for its whole life, because its peers
 * share a mediasoup router and a router lives in one process. This is the
 * cluster-wide index of that: `GET /rooms/:id/node` reads it, and the client
 * connects to whatever it says.
 *
 * Redis, not the database, for two reasons: it is read on every join, and the
 * data is worthless after a restart — a node that is gone holds no rooms.
 */

import { env } from '../config/env.js';
import { redis } from '../db/redis.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'room-registry' });

const roomKey = (roomId) => `${env.REDIS_PREFIX}:sfu:room:${roomId}`;
const nodesKey = `${env.REDIS_PREFIX}:sfu:nodes`;
const nodeKey = (nodeId) => `${env.REDIS_PREFIX}:sfu:node:${nodeId}`;

/**
 * A room assignment outlives a long lecture but not a forgotten one. Refreshed
 * on every join, so an active room never expires under its own peers.
 */
const ROOM_TTL_SEC = 6 * 3_600;
/** A node that stops heartbeating disappears from the pool within this. */
const NODE_TTL_SEC = 45;

// ---------------------------------------------------------------------------
// Node pool
// ---------------------------------------------------------------------------

/**
 * Heartbeat. Publishes this node's load so assignment can pick the emptiest
 * one, and refreshes the TTL that keeps it in the pool at all.
 */
export const heartbeat = async ({ rooms, producers, draining = false }) => {
  const payload = JSON.stringify({
    nodeId: env.SFU_NODE_ID,
    announcedIp: env.ANNOUNCED_IP,
    wsUrl: `wss://${env.ANNOUNCED_IP}:${env.SFU_HTTP_PORT}`,
    rooms,
    producers,
    maxRooms: env.SFU_MAX_ROOMS_PER_NODE,
    draining,
    at: Date.now(),
  });

  await redis
    .multi()
    .set(nodeKey(env.SFU_NODE_ID), payload, 'EX', NODE_TTL_SEC)
    .sadd(nodesKey, env.SFU_NODE_ID)
    .exec();
};

export const startHeartbeat = ({ intervalMs = 15_000 } = {}) => {
  const tick = async () => {
    const { getRoomCount, getProducerCount } = await import('./RoomManager.js');
    const { isDraining } = await import('../lifecycle/drainSfu.js');
    await heartbeat({
      rooms: getRoomCount(),
      producers: getProducerCount(),
      draining: isDraining(),
    }).catch((cause) => log.error({ err: cause }, 'heartbeat failed'));
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};

/**
 * Takes this node out of the pool. Existing rooms keep resolving to it — they
 * cannot move — but nothing new is assigned here.
 *
 * Called by lifecycle/drainSfu.js when deploy-sfu.yml sets the SSM flag.
 */
export const markNodeDraining = async (nodeId = env.SFU_NODE_ID) => {
  const raw = await redis.get(nodeKey(nodeId));
  if (raw) {
    const node = JSON.parse(raw);
    node.draining = true;
    await redis.set(nodeKey(nodeId), JSON.stringify(node), 'EX', NODE_TTL_SEC);
  }
  await redis.srem(nodesKey, nodeId);
  log.warn({ nodeId }, 'node removed from the assignment pool');
};

const listNodes = async () => {
  const ids = await redis.smembers(nodesKey);
  if (ids.length === 0) return [];

  const raw = await redis.mget(ids.map(nodeKey));
  return raw
    .map((entry, index) => {
      if (!entry) {
        // The key expired but the set entry lingered; tidy it up.
        void redis.srem(nodesKey, ids[index]);
        return null;
      }
      return JSON.parse(entry);
    })
    .filter((node) => node && !node.draining && node.rooms < node.maxRooms);
};

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * Resolves the node for a room, assigning one if it has none.
 *
 * `SET NX` is what makes this safe: two people joining a new lesson at the same
 * moment must not be sent to two different nodes, which would give them two
 * routers and no shared media.
 *
 * @param {{ roomId: string, avoid?: string[] }} options
 */
export const resolveNode = async ({ roomId, avoid = [] }) => {
  const existing = await redis.get(roomKey(roomId));
  if (existing && !avoid.includes(existing)) {
    await redis.expire(roomKey(roomId), ROOM_TTL_SEC);
    const raw = await redis.get(nodeKey(existing));
    if (raw) return { ...JSON.parse(raw), assigned: false };
    // The node is gone. The room is gone with it, so a fresh assignment is
    // correct rather than an error.
    log.warn({ roomId, nodeId: existing }, 'assigned node has disappeared; reassigning');
    await redis.del(roomKey(roomId));
  }

  const candidates = (await listNodes()).filter((node) => !avoid.includes(node.nodeId));
  if (candidates.length === 0) {
    throw Object.assign(new Error('no SFU node is available'), { code: 'sfu_unavailable' });
  }

  // Emptiest node. Least-loaded rather than round-robin, because lessons have
  // very different lengths and round-robin drifts.
  const chosen = candidates.reduce((best, node) => (node.rooms < best.rooms ? node : best));

  const won = await redis.set(roomKey(roomId), chosen.nodeId, 'EX', ROOM_TTL_SEC, 'NX');
  if (!won) {
    // Someone else assigned it a millisecond ago. Use theirs.
    const actual = await redis.get(roomKey(roomId));
    const raw = await redis.get(nodeKey(actual));
    return raw ? { ...JSON.parse(raw), assigned: false } : chosen;
  }

  log.info({ roomId, nodeId: chosen.nodeId }, 'room assigned to node');
  return { ...chosen, assigned: true };
};

export const releaseRoom = async (roomId) => {
  await redis.del(roomKey(roomId));
};

export const whereIs = async (roomId) => redis.get(roomKey(roomId));

export const poolStatus = async () => {
  const nodes = await listNodes();
  return {
    nodes: nodes.length,
    rooms: nodes.reduce((total, node) => total + node.rooms, 0),
    capacity: nodes.reduce((total, node) => total + node.maxRooms, 0),
  };
};

export default { resolveNode, markNodeDraining, releaseRoom };