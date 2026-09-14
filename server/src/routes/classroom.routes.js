/**
 * classroom.routes — rooms and join authorisation. [UNCHANGED — reference fassung]
 *
 * HTTP does the deciding; the socket does the doing. Everything that needs a database — may
 * this person join, is there a seat left, which node — happens here, and the client arrives
 * at the SFU with an answer already in hand. The signalling socket then only has to verify,
 * not authorise.
 *
 * The split matters under load: a room filling up with two hundred people would otherwise
 * mean two hundred entitlement lookups inside the WebSocket handshake, on the media node,
 * which is the one process that must never wait on Postgres.
 */

import { Router } from 'express';
import { z } from 'zod';

import * as RoomManager from '../classroom/RoomManager.js';
import * as RoomRegistry from '../classroom/RoomRegistry.js';
import * as AttendanceService from '../classroom/AttendanceService.js';
import * as CapacityGuard from '../capacity/CapacityGuard.js';
import * as LimitResolver from '../billing/LimitResolver.js';
import * as recordingPipeline from '../mediasoup/recording/recordingPipeline.js';
import * as AssetDelivery from '../media/AssetDelivery.js';
import { route, validate, requireAuth, requireRole, tenantOf, notFound, forbidden, conflict, q } from './_helpers.js';

const router = Router();
router.use(requireAuth);

const TEACHERS = ['owner', 'teacher'];
const roomParam = z.object({ id: z.string().min(1).max(64) });

/* ------------------------------------------------------------------ *
 * Rooms
 * ------------------------------------------------------------------ */

router.post(
  '/rooms',
  requireRole(...TEACHERS),
  validate({
    body: z.object({
      lessonId: z.string().uuid().nullish(),
      sessionId: z.string().uuid().nullish(),
      title: z.string().max(200).optional(),
      waitingRoom: z.boolean().default(true),
      maxPeers: z.number().int().min(2).max(500).optional(),
    }),
  }),
  route(async (req, res) => {
    const tenantId = tenantOf(req);

    // Plan limits are resolved before a room exists, not when the 201st person knocks.
    const limits = await LimitResolver.forTenant(tenantId);
    const openRooms = await RoomManager.countOpen(tenantId);
    if (limits.maxRooms > 0 && openRooms >= limits.maxRooms) {
      throw conflict('Your plan does not allow another concurrent room', {
        openRooms,
        maxRooms: limits.maxRooms,
      });
    }

    const room = await RoomManager.createRoom({
      tenantId,
      createdBy: req.user.id,
      lessonId: req.body.lessonId ?? null,
      sessionId: req.body.sessionId ?? null,
      title: req.body.title ?? null,
      waitingRoom: req.body.waitingRoom,
      maxPeers: Math.min(req.body.maxPeers ?? limits.maxPeersPerRoom, limits.maxPeersPerRoom),
    });

    res.status(201).set('Location', `/rooms/${room.id}`);
    return room;
  }),
);

router.get(
  '/rooms/:id',
  validate({ params: roomParam }),
  route(async (req) => {
    const room = await RoomManager.describe(req.params.id, { viewerId: req.user.id });
    if (!room) throw notFound('No such room');
    return room;
  }),
);

/**
 * The pre-flight the client calls before opening a socket. It answers three questions in
 * one round trip — may I join, is there room, and where is the node — so the handshake
 * itself stays a signature check.
 */
router.post(
  '/rooms/:id/join-token',
  validate({ params: roomParam, body: z.object({ device: z.string().max(64).optional() }).default({}) }),
  route(async (req) => {
    const room = await RoomManager.describe(req.params.id, { viewerId: req.user.id });
    if (!room) throw notFound('No such room');
    if (room.status === 'closed') throw conflict('This room has ended');

    const permitted = await RoomManager.mayJoin({ room, userId: req.user.id, role: req.user.role });
    if (!permitted.allowed) throw forbidden(permitted.reason ?? 'You cannot join this room');

    const seats = await CapacityGuard.check({ tenantId: tenantOf(req), roomId: room.id });
    if (!seats.ok) throw conflict('The room is full for this plan', { limit: seats.limit });

    const node = await RoomRegistry.resolveOrAssign(room.id);

    return {
      roomId: room.id,
      // Short-lived and scoped to this room, so a leaked token is not a key to every room.
      token: await RoomManager.issueJoinToken({
        roomId: room.id,
        userId: req.user.id,
        role: permitted.role,
        ttlSeconds: 120,
      }),
      node: { id: node.nodeId, wsUrl: node.wsUrl },
      waitingRoom: room.waitingRoom && !TEACHERS.includes(permitted.role),
    };
  }),
);

router.post(
  '/rooms/:id/end',
  requireRole(...TEACHERS),
  validate({ params: roomParam }),
  route(async (req) => {
    const result = await RoomManager.endRoom(req.params.id, { actorId: req.user.id });
    if (!result) throw notFound('No such room');
    return result;
  }),
);

/* ------------------------------------------------------------------ *
 * After the lesson
 * ------------------------------------------------------------------ */

router.get(
  '/rooms/:id/attendance',
  requireRole(...TEACHERS),
  validate({ params: roomParam, query: z.object({ format: z.enum(['json', 'csv']).optional() }) }),
  route(async (req, res) => {
    const ledger = await AttendanceService.forRoom(req.params.id, { format: q(req).format ?? 'json' });

    if (q(req).format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="attendance-${req.params.id}.csv"`);
      res.set('Cache-Control', 'no-store');
      res.send(ledger.csv);
      return undefined;
    }
    return ledger;
  }),
);

router.get(
  '/rooms/:id/recordings',
  validate({ params: roomParam }),
  route(async (req) => {
    const recordings = await recordingPipeline.listForRoom(req.params.id, { viewerId: req.user.id });
    return {
      recordings: await Promise.all(
        recordings.map(async (recording) => ({
          ...recording,
          // Signed, short TTL, separate origin — same rule as every other asset.
          playbackUrl: recording.assetId
            ? await AssetDelivery.signedUrl(recording.assetId, { ttlSeconds: 3600 })
            : null,
        })),
      ),
    };
  }),
);

export default router;