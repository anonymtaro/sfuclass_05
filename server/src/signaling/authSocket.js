// classroom-app/server/src/signaling/authSocket.js
/**
 * Socket handshake authentication  (F1, F7)
 *
 * REWRITTEN. The file that was here contained SQL migration content and could
 * not be parsed, so realtime/index.js fell back to trusting every handshake.
 *
 * This is the only place a socket's identity is established. Every handler in
 * signaling/socketHandlers.js and messaging/chatGateway.js reads identity from
 * `socket.data` and never from a payload, which is what makes it impossible for
 * a client to claim to be someone else by sending a different userId.
 *
 * By the time a handler runs, this has populated:
 *
 *     socket.data = { userId, tenantId, role, displayName, avatarUrl,
 *                     deviceId, sessionId, traceId }
 *
 * or rejected the connection.
 *
 * Verification is RS256 with the *public* key. That asymmetry is the point: the
 * SFU has to check tokens but must never be able to mint them, so a compromised
 * media node cannot issue itself a teacher token. A shared secret would give
 * every verifier the ability to forge.
 *
 * Revocation is checked against SessionStore on connect, not only at signing
 * time. An access token lives fifteen minutes; a socket lives as long as the
 * lesson. Without this check, signing out on a stolen device would leave the
 * socket connected until the room ended.
 */

import { createPublicKey } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import { jwtVerify } from 'jose';

import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'auth-socket' });

/**
 * Imported lazily so this module stays usable in tests that do not stand up a
 * Redis connection, and so a missing SessionStore degrades to "no revocation
 * check" rather than refusing every connection.
 */
let isRevoked = null;

const loadRevocationCheck = async () => {
  if (isRevoked !== null) return isRevoked;
  try {
    const store = await import('../identity/SessionStore.js');
    const fn =
      store.isRevoked ?? store.isSessionRevoked ?? store.default?.isRevoked ?? null;
    isRevoked = typeof fn === 'function' ? fn : false;
  } catch {
    isRevoked = false;
  }
  if (isRevoked === false) {
    log.warn('SessionStore exposes no revocation check — revoked sessions keep their sockets');
  }
  return isRevoked;
};

/** Cached: parsing a PEM on every connection is pure waste. */
let publicKey = null;

const getPublicKey = () => {
  if (publicKey) return publicKey;
  if (!env.JWT_PUBLIC_KEY) {
    throw new Error('JWT_PUBLIC_KEY is not configured; run `npm run keys:generate`');
  }
  publicKey = createPublicKey(env.JWT_PUBLIC_KEY);
  return publicKey;
};

/**
 * Socket.IO puts handshake auth in three places depending on the client. Read
 * all of them rather than making every client agree on one.
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
 * socketClient.ts tell a terminal auth failure from a transient one and stop
 * retrying into a rejection.
 */
const reject = (code, message) => {
  const error = new Error(message);
  error.data = { code };
  return error;
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

  let payload;
  try {
    ({ payload } = await jwtVerify(token, getPublicKey(), {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['RS256'],
      // A little slack for clock drift between the API and the SFU node.
      clockTolerance: 5,
    }));
  } catch (cause) {
    // An expired token is ordinary — the client refreshes and reconnects — so
    // it is separated from a malformed or forged one, which is not.
    const expired = cause?.code === 'ERR_JWT_EXPIRED';
    log[expired ? 'debug' : 'warn'](
      { socketId: socket.id, traceId, err: cause?.code ?? cause?.message },
      expired ? 'handshake with an expired token' : 'handshake with an invalid token',
    );
    return next(
      reject(
        expired ? 'token_expired' : 'unauthenticated',
        expired ? 'The access token has expired' : 'The access token is not valid',
      ),
    );
  }

  const { sub: userId, tid: tenantId, sid: sessionId, role, name, avatar, did: deviceId } = payload;

  if (!userId || !tenantId) {
    log.warn({ socketId: socket.id, traceId }, 'token is missing sub or tid');
    return next(reject('unauthenticated', 'The access token is incomplete'));
  }

  // A signed-out session must not keep a socket it opened while signed in.
  const revokedCheck = await loadRevocationCheck();
  if (revokedCheck && sessionId) {
    try {
      if (await revokedCheck(sessionId)) {
        log.info({ socketId: socket.id, userId, sessionId, traceId }, 'handshake from a revoked session');
        return next(reject('token_revoked', 'This session has been signed out'));
      }
    } catch (cause) {
      // Redis being unreachable must not lock everyone out of their lessons.
      // The token is still cryptographically valid and short-lived; letting it
      // through is the lesser failure.
      log.error({ err: cause, traceId }, 'revocation check failed — allowing the connection');
    }
  }

  socket.data.userId = userId;
  socket.data.tenantId = tenantId;
  socket.data.sessionId = sessionId ?? null;
  socket.data.deviceId = deviceId ?? null;
  // Tenant role. The *room* role is decided per join by ModerationControls and
  // is deliberately not taken from the token.
  socket.data.role = role ?? 'learner';
  socket.data.displayName = name ?? 'Participant';
  socket.data.avatarUrl = avatar ?? null;

  log.debug({ socketId: socket.id, userId, tenantId, traceId }, 'handshake accepted');
  return next();
};

export default authSocket;