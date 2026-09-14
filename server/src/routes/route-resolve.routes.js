/**
 * route-resolve.routes — GET /rooms/:id/node. [UNCHANGED — reference fassung]
 *
 * The smallest route in the system and the one that decides whether a lesson works.
 *
 * mediasoup is not stateless: a room's transports, producers and consumers live in the
 * memory of one SFU process. Every participant in a room must therefore land on the *same*
 * node, and the ALB cannot do that — it balances connections, not rooms. So the client asks
 * here first, gets a node, and connects to that node's WSS endpoint directly.
 *
 * The mapping lives in Redis (RoomRegistry), because the answer must be identical across
 * every API task and must survive an API task being replaced mid-lesson.
 *
 * Assignment happens once, on the first request for a room, and is sticky until the room
 * ends. A drained node is never assigned a new room, which is what makes a rolling SFU
 * deploy invisible to lessons that have not started yet.
 */

import { Router } from 'express';
import { z } from 'zod';

import * as RoomRegistry from '../classroom/RoomRegistry.js';
import { route, validate, requireAuth, notFound, noStore } from './_helpers.js';

const router = Router();

router.get(
  '/rooms/:id/node',
  requireAuth,
  validate({ params: z.object({ id: z.string().min(1).max(64) }) }),
  route(async (req, res) => {
    // Never cached, not even for a second: a cached answer outlives a node replacement and
    // sends people to an SFU that no longer exists.
    noStore(res);

    const node = await RoomRegistry.resolveOrAssign(req.params.id, {
      tenantId: req.user.tenantId,
    });

    if (!node) {
      // Every node is draining or at capacity. A 503 with Retry-After is honest; a 500 makes
      // the client give up.
      res.status(503).set('Retry-After', '5');
      return { error: { code: 'NO_CAPACITY', message: 'No SFU node available, retry shortly' } };
    }

    return {
      roomId: req.params.id,
      nodeId: node.nodeId,
      wsUrl: node.wsUrl,        // wss://sfu-3.example.com
      // The client needs these before it can create a transport.
      iceServers: node.iceServers,
      assignedAt: node.assignedAt,
    };
  }),
);

/**
 * Node inventory, for the drain script and the on-call runbook. Not a public endpoint: it
 * exposes the topology.
 */
router.get(
  '/rooms/nodes',
  requireAuth,
  route(async (req, res) => {
    if (req.user.role !== 'owner') throw notFound('Not found'); // 404, not 403 — do not confirm it exists
    noStore(res);
    return { nodes: await RoomRegistry.listNodes() };
  }),
);

export default router;