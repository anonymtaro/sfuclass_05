// classroom-app/server/src/realtime/index.js
/**
 * Socket gateways  (F1, F2, F6, F7)
 *
 * One Socket.IO server, four namespaces. server.js calls
 * `attachSocketGateways(server, { redis })` once and gets back something it can
 * close during a drain.
 *
 *   /classroom   signalling: transports, producers, consumers, screen share
 *   /chat        direct messages and public channels
 *   /community   presence, feeds, notifications
 *
 * The Redis adapter is what makes those namespaces work across more than one
 * task. Without it a message published on task A never reaches a socket held by
 * task B, and the bug only appears once the service scales past one — which is
 * to say, in production and not in development.
 *
 * On the defensive imports below: the gateway modules in this folder predate
 * this file and their exported names are not uniform. Rather than hard-fail the
 * whole server because one gateway exports `register` where another exports
 * `default`, each is resolved at runtime and a miss is logged and skipped. The
 * classroom namespace is the exception — it is the reason this server exists,
 * so a failure there is fatal.
 */

import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';

import { env, isProduction } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { registerSocketHandlers } from '../signaling/socketHandlers.js';

const log = logger.child({ component: 'realtime' });

/**
 * Picks the first callable export from a module.
 *
 * @param {object} module
 * @param {string[]} names candidate export names, in order of preference
 */
const pickExport = (module, names) => {
  for (const name of names) {
    const value = module?.[name];
    if (typeof value === 'function') return { fn: value, name };
  }
  if (typeof module?.default === 'function') return { fn: module.default, name: 'default' };
  return null;
};

/** Imports a module that may not exist, without taking the server down. */
const optionalImport = async (specifier) => {
  try {
    return await import(specifier);
  } catch (cause) {
    log.warn({ specifier, err: cause?.message }, 'optional gateway module not loaded');
    return null;
  }
};

export const attachSocketGateways = async (httpServer, { redis }) => {
  const io = new Server(httpServer, {
    // WebSocket only. Long-polling doubles the connection count on the ALB and
    // behaves badly with sticky sessions.
    transports: ['websocket'],
    cors: {
      origin: env.ALLOWED_ORIGINS,
      credentials: true,
    },
    pingInterval: env.SOCKET_PING_INTERVAL_MS,
    pingTimeout: env.SOCKET_PING_TIMEOUT_MS,
    // Above any single message the product sends; an upload never travels here.
    maxHttpBufferSize: 1e6,
  });

  // -------------------------------------------------------------------------
  // Cross-node fan-out
  // -------------------------------------------------------------------------

  try {
    // Separate connections: a client in subscribe mode cannot issue commands,
    // so the shared pool cannot be reused for the subscriber half.
    const pubClient = redis.duplicate();
    const subClient = redis.duplicate();
    io.adapter(createAdapter(pubClient, subClient, { key: `${env.REDIS_PREFIX}:socket.io` }));
    log.info('redis adapter attached');
  } catch (cause) {
    // Single-node development still works without it; production does not, so
    // this is an error there rather than a note.
    log[isProduction ? 'error' : 'warn'](
      { err: cause },
      'redis adapter not attached — sockets will not fan out across tasks',
    );
  }

  // -------------------------------------------------------------------------
  // Handshake authentication
  // -------------------------------------------------------------------------

  const authModule = await optionalImport('../signaling/authSocket.js');
  const auth = authModule
    ? pickExport(authModule, ['authSocket', 'authenticateSocket', 'socketAuth', 'createAuthSocket'])
    : null;

  if (auth) {
    // Some implementations are the middleware; others are a factory returning
    // one. A middleware takes (socket, next) — two arguments — which is what
    // tells them apart.
    const middleware = auth.fn.length >= 2 ? auth.fn : auth.fn();
    io.use(middleware);
    log.info({ export: auth.name }, 'socket authentication attached');
  } else {
    // Refusing to boot is the only safe response in production: an unguarded
    // namespace would let anyone join any room.
    if (isProduction) {
      throw new Error('signaling/authSocket.js exports no usable middleware');
    }
    log.warn('no socket authentication found — DEVELOPMENT ONLY, every handshake is trusted');

    io.use((socket, next) => {
      // Enough shape for socketHandlers to work: it reads userId, tenantId,
      // displayName and avatarUrl off socket.data and never from the payload.
      const { token, userId, displayName } = socket.handshake.auth ?? {};
      socket.data.userId = userId ?? `dev-${socket.id}`;
      socket.data.tenantId = 'dev-tenant';
      socket.data.role = 'teacher';
      socket.data.displayName = displayName ?? `Guest ${socket.id.slice(0, 4)}`;
      socket.data.avatarUrl = null;
      socket.data.token = token ?? null;
      next();
    });
  }

  // -------------------------------------------------------------------------
  // Namespaces
  // -------------------------------------------------------------------------

  // Fatal if this throws. Everything else here is optional; this is not.
  registerSocketHandlers(io);
  log.info('classroom namespace registered');

  const chatModule = await optionalImport('../messaging/chatGateway.js');
  const chat = chatModule
    ? pickExport(chatModule, ['registerChatGateway', 'attachChatGateway', 'chatGateway'])
    : null;
  if (chat) {
    chat.fn(io);
    log.info({ export: chat.name }, 'chat namespace registered');
  }

  const presenceModule = await optionalImport('./presenceGateway.js');
  const presence = presenceModule
    ? pickExport(presenceModule, [
        'registerPresenceGateway',
        'attachPresenceGateway',
        'presenceGateway',
      ])
    : null;
  if (presence) {
    presence.fn(io);
    log.info({ export: presence.name }, 'presence namespace registered');
  }

  // -------------------------------------------------------------------------
  // Shutdown surface
  // -------------------------------------------------------------------------

  /**
   * server.js calls this before closing sockets, so clients reconnect
   * elsewhere rather than discovering a dead socket by timeout.
   */
  io.emitToAll = (event, payload) => {
    for (const namespace of io._nsps.values()) {
      namespace.emit(event, payload);
    }
  };

  const close = () =>
    new Promise((resolve) => {
      io.close(() => resolve());
    });

  return Object.assign(io, { close, emitToAll: io.emitToAll });
};

export default attachSocketGateways;