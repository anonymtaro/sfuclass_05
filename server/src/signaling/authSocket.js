// classroom-app/server/src/signaling/authSocket.js
/**
 * Socket handshake authentication  (F1, F7)
 *
 * The only place a socket's identity is established. Every handler in
 * signaling/socketHandlers.js and messaging/chatGateway.js reads identity from
 * `socket.data` and never from a payload, which is what makes it impossible for
 * a client to claim to be someone else by sending a different userId.
 *
 * Verification is delegated to AuthService.verifyAccessToken rather than
 * repeated here. That function already checks the signature, the issuer and
 * audience, `Sessions.isRevoked(jti)` for a specific signed-out token, and
 * `isIssuedBeforeRevocation` for every token issued before a password change.
 * A second implementation would drift from it, and the half that drifts is
 * always the one guarding the sockets.
 *
 * The tenant is looked up rather than read from the token, because
 * issueAccessToken signs only `{ role, sid }` plus the standard claims — there
 * is no tenant in it. socketHandlers needs one for CapacityGuard.reserveSeat
 * and RoomManager.createRoom, so it comes from the users row. One query per
 * connection, not per event; a socket lives for the length of a lesson.
 *
 * By the time a handler runs this has populated:
 *
 *     socket.data = { userId, tenantId, role, displayName, avatarUrl,
 *                     sessionId, jti, traceId }
 *
 * or rejected the connection.
 */

import { randomUUID } from 'node:crypto';

import { verifyAccessToken } from '../identity/AuthService.js';
import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'auth-socket' });

/**
 * Socket.IO puts handshake credentials in three places depending on the client.
 * Reading all three beats making every client agree on one.
 */
const extractToken = (socket) => {
  const fromAuth = socket.handshake.auth?.token;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

  const header = socket.handshake.headers?.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);

  const fromQuery = socket.handshake.query?.token;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;

  return null;
};

/**
 * Socket.IO surfaces `error.data` to the client. The code is what lets
 * socketClient.ts tell a terminal failure from a transient one and stop
 * retrying into a rejection it will never win.
 */
const reject = (code, message) => {
  const error = new Error(message);
  error.data = { code };
  return error;
};

/**
 * Tenant and display identity for the peer list.
 *
 * Deliberately not cached: a socket opens once per lesson, so this runs once
 * per lesson, and a cache would mean a renamed user keeps their old name in
 * every room until it expires.
 */
const loadIdentity = async (userId) => {
  const { rows } = await pool.query(
    `SELECT tenant_id, display_name, avatar_url
       FROM users
      WHERE id = $1
        AND deleted_at IS NULL`,
    [userId],
  );
  return rows[0] ?? null;
};

/**
 * Connection middleware. Registered with `io.use(...)` in realtime/index.js.
 *
 * @param {import('socket.io').Socket} socket
 * @param {(err?: Error) => void} next
 */
export const authSocket = async (socket, next) => {
  const traceId = socket.handshake.headers?.['x-trace-id'] ?? randomUUID();
  socket.data.traceId = traceId;

  const token = extractToken(socket);
  if (!token) {
    log.debug({ socketId: socket.id, traceId }, 'handshake without a token');
    return next(reject('unauthenticated', 'No access token presented'));
  }

  let claims;
  try {
    claims = await verifyAccessToken(token);
  } catch (cause) {
    // AuthService attaches a code: 'unauthenticated' for expired or malformed,
    // 'token_revoked' for a signed-out session. Both are terminal for this
    // connection; only the first is worth retrying after a refresh.
    const code = cause?.code === 'token_revoked' ? 'token_revoked' : 'unauthenticated';
    log.debug({ socketId: socket.id, traceId, code }, 'handshake rejected');
    return next(reject(code, cause?.message ?? 'The access token is not valid'));
  }

  let identity;
  try {
    identity = await loadIdentity(claims.userId);
  } catch (cause) {
    // A database that is down must not look like a rejected credential —
    // the client would sign the user out over an outage.
    log.error({ err: cause, userId: claims.userId, traceId }, 'identity lookup failed');
    return next(reject('dependency_unavailable', 'Could not verify your account right now'));
  }

  if (!identity) {
    // The token is valid but the account is gone or soft-deleted. Revoked is
    // the honest code: the credential is real, the subject is not.
    log.warn({ userId: claims.userId, traceId }, 'token for an account that no longer exists');
    return next(reject('token_revoked', 'This account is no longer active'));
  }

  socket.data.userId = claims.userId;
  socket.data.sessionId = claims.sessionId ?? null;
  socket.data.jti = claims.jti ?? null;
  socket.data.tenantId = identity.tenant_id;
  // Tenant role. The *room* role — host, cohost, learner — is decided per join
  // by ModerationControls and is deliberately not taken from the token.
  socket.data.role = claims.role ?? 'learner';
  socket.data.displayName = identity.display_name ?? 'Participant';
  socket.data.avatarUrl = identity.avatar_url ?? null;

  log.debug(
    { socketId: socket.id, userId: claims.userId, tenantId: identity.tenant_id, traceId },
    'handshake accepted',
  );
  return next();
};

export default authSocket;