/**
 * Socket transport  (F6, F7)
 *
 * Implements SignalingTransport, which is what SfuClient, useChat, useCommunity,
 * usePresence and useUpload all talk to. One class serves all four namespaces;
 * you create one client per namespace, because their lifecycles differ — the
 * classroom connection dies when a lesson ends, the chat connection lives as
 * long as the session.
 *
 * The three things this file exists to get right:
 *
 *   Reconnection. Socket.IO already retries with backoff. What it does not do
 *   is refresh an expired access token first, so a reconnect after a long sleep
 *   would loop forever against a 401 handshake. The token is refreshed before
 *   every attempt.
 *
 *   Resume. Reconnecting is not the same as being back. Subscriptions are per
 *   connection and they are gone, so `onResume` fires after every successful
 *   reconnect and callers re-subscribe and catch up from their last cursor. A
 *   client that skips this looks connected and silently receives nothing.
 *
 *   Acknowledgements. Every server ack is `{ ok }`. Unwrapping and timing them
 *   out here means callers deal in values and ApiErrors, never in envelopes.
 */

import { io, type Socket } from 'socket.io-client';
import { ApiError, type SocketAck } from '@classroom/contracts';
import type { SignalingTransport } from '../rtc/SfuClient.js';

export type SocketState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface ResumeInfo {
  /** How many attempts it took. 1 means the first retry worked. */
  attempts: number;
  /** Milliseconds the connection was down. Drives "catch up from" decisions. */
  downtimeMs: number;
}

export interface SocketClientOptions {
  /** '/chat', '/classroom', '/community' or '/media'. */
  namespace: string;
  /** Read before every connect and every reconnect attempt. */
  getAccessToken(): string | null | Promise<string | null>;
  /** How long to wait for an ack before giving up. */
  ackTimeoutMs?: number;
  reconnectionDelayMs?: number;
  maxReconnectionDelayMs?: number;
  /** 0 disables reconnection entirely. Infinity is the default. */
  maxReconnectionAttempts?: number;
  logger?: { debug(...args: unknown[]): void; warn(...args: unknown[]): void };
  /** Injectable for tests; defaults to socket.io-client. */
  ioFactory?: typeof io;
}

export interface SocketClient extends SignalingTransport {
  readonly state: SocketState;
  onStateChange(listener: (state: SocketState) => void): () => void;
  /** Fires after each successful reconnect. Re-subscribe and sync in here. */
  onResume(listener: (info: ResumeInfo) => void | Promise<void>): () => void;
  /** Force a token refresh into the handshake, e.g. after a manual sign-in. */
  refreshAuth(): Promise<void>;
}

const DEFAULTS = {
  ackTimeoutMs: 10_000,
  reconnectionDelayMs: 500,
  maxReconnectionDelayMs: 15_000,
  maxReconnectionAttempts: Number.POSITIVE_INFINITY,
};

/** A handshake failure that will never succeed on retry. */
const isAuthError = (error: Error): boolean => {
  const message = error.message.toLowerCase();
  return (
    message.includes('unauthorized') ||
    message.includes('unauthenticated') ||
    message.includes('forbidden') ||
    message.includes('token')
  );
};

export const createSocketClient = (options: SocketClientOptions): SocketClient => {
  const {
    namespace,
    getAccessToken,
    ackTimeoutMs = DEFAULTS.ackTimeoutMs,
    reconnectionDelayMs = DEFAULTS.reconnectionDelayMs,
    maxReconnectionDelayMs = DEFAULTS.maxReconnectionDelayMs,
    maxReconnectionAttempts = DEFAULTS.maxReconnectionAttempts,
    logger,
    ioFactory = io,
  } = options;

  let socket: Socket | null = null;
  let state: SocketState = 'idle';
  let disconnectedAt: number | null = null;
  let attempts = 0;
  /** Set when the caller asked to disconnect, so we do not retry into it. */
  let closedDeliberately = false;

  const stateListeners = new Set<(state: SocketState) => void>();
  const resumeListeners = new Set<(info: ResumeInfo) => void | Promise<void>>();
  /**
   * Listeners registered before the socket exists, and re-applied after every
   * reconnect. Socket.IO keeps handlers across reconnects, but not across the
   * socket being recreated, and callers should not have to know the difference.
   */
  const handlers = new Map<string, Set<(payload: never) => void>>();

  const setState = (next: SocketState) => {
    if (state === next) return;
    state = next;
    for (const listener of stateListeners) listener(next);
  };

  const applyHandlers = (target: Socket) => {
    for (const [event, listeners] of handlers) {
      for (const listener of listeners) target.on(event, listener as (...a: unknown[]) => void);
    }
  };

  const client: SocketClient = {
    get state() {
      return state;
    },

    get connected() {
      return socket?.connected ?? false;
    },

    async connect(url: string, auth: Record<string, unknown>): Promise<void> {
      // An existing live connection to the same place is not an error.
      if (socket?.connected) return;
      socket?.close();
      closedDeliberately = false;
      setState('connecting');

      const token = await getAccessToken();
      const target = `${url.replace(/\/$/, '')}${namespace}`;

      const next = ioFactory(target, {
        // WebSocket only. Long-polling doubles the connection count on the ALB
        // and behaves badly with sticky sessions.
        transports: ['websocket'],
        auth: { ...auth, token },
        reconnection: maxReconnectionAttempts > 0,
        reconnectionDelay: reconnectionDelayMs,
        reconnectionDelayMax: maxReconnectionDelayMs,
        reconnectionAttempts: Number.isFinite(maxReconnectionAttempts)
          ? maxReconnectionAttempts
          : Infinity,
        // Spreads a reconnect storm after a deploy instead of synchronising it.
        randomizationFactor: 0.5,
        timeout: 10_000,
        autoConnect: true,
      });

      socket = next;
      applyHandlers(next);

      /**
       * Socket.IO does not await anything here, so the token is fetched and
       * assigned optimistically. If it is not ready in time the attempt fails
       * and the next one — moments later — carries it.
       */
      next.io.on('reconnect_attempt', (attempt: number) => {
        attempts = attempt;
        setState('reconnecting');
        void Promise.resolve(getAccessToken()).then((fresh) => {
          next.auth = { ...auth, token: fresh };
        });
      });

      next.on('connect', () => {
        const wasDown = disconnectedAt !== null;
        const downtimeMs = disconnectedAt ? Date.now() - disconnectedAt : 0;
        disconnectedAt = null;
        setState('connected');

        if (wasDown) {
          // Subscriptions did not survive. Callers re-establish them here.
          const info: ResumeInfo = { attempts, downtimeMs };
          attempts = 0;
          for (const listener of resumeListeners) void listener(info);
        }
      });

      next.on('disconnect', (reason: string) => {
        disconnectedAt ??= Date.now();
        logger?.debug('socket disconnected', namespace, reason);

        // 'io server disconnect' means the server hung up deliberately —
        // usually a revoked session. Retrying would just be rejected.
        if (reason === 'io server disconnect' || closedDeliberately) {
          setState('closed');
          return;
        }
        setState('reconnecting');
      });

      next.io.on('reconnect_failed', () => {
        logger?.warn('socket gave up reconnecting', namespace);
        setState('closed');
      });

      await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          next.off('connect_error', onError);
          resolve();
        };
        const onError = (error: Error) => {
          // Auth failures are terminal; anything else is worth retrying, and
          // Socket.IO is already retrying in the background.
          if (isAuthError(error)) {
            next.off('connect', onConnect);
            next.close();
            setState('closed');
            reject(
              new ApiError('unauthenticated', {
                detail: 'The socket handshake was rejected.',
                cause: error,
              }),
            );
          }
        };
        next.once('connect', onConnect);
        next.on('connect_error', onError);
      });
    },

    disconnect(): void {
      closedDeliberately = true;
      socket?.close();
      socket = null;
      disconnectedAt = null;
      setState('closed');
    },

    /**
     * Every call goes out with a timeout. A socket that is open but wedged is
     * far more common than one that is cleanly closed, and without a timeout a
     * caller waits forever for an ack that will never arrive.
     */
    async emitWithAck<TResponse = unknown>(
      event: string,
      payload: unknown,
    ): Promise<SocketAck<TResponse>> {
      const current = socket;
      if (!current?.connected) {
        return {
          ok: false,
          error: new ApiError('dependency_unavailable', {
            detail: 'The connection is down.',
          }).toJSON(),
        };
      }

      try {
        const raw = (await current
          .timeout(ackTimeoutMs)
          .emitWithAck(event, payload)) as SocketAck<TResponse> | undefined;

        // A handler that forgot to acknowledge is a server bug, not a protocol
        // state; surfacing it as an error beats hanging the caller.
        if (!raw || typeof raw !== 'object' || !('ok' in raw)) {
          return {
            ok: false,
            error: new ApiError('internal_error', {
              detail: `The server did not acknowledge ${event} correctly.`,
            }).toJSON(),
          };
        }
        return raw;
      } catch (cause) {
        return {
          ok: false,
          error: new ApiError('dependency_unavailable', {
            detail: `No response to ${event} within ${ackTimeoutMs}ms.`,
            retryAfter: 1,
            cause,
          }).toJSON(),
        };
      }
    },

    on(event: string, listener: (payload: never) => void): void {
      const set = handlers.get(event) ?? new Set();
      set.add(listener);
      handlers.set(event, set);
      socket?.on(event, listener as (...args: unknown[]) => void);
    },

    off(event: string, listener?: (payload: never) => void): void {
      if (listener) {
        handlers.get(event)?.delete(listener);
        socket?.off(event, listener as (...args: unknown[]) => void);
      } else {
        handlers.delete(event);
        socket?.off(event);
      }
    },

    onStateChange(listener): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    onResume(listener): () => void {
      resumeListeners.add(listener);
      return () => resumeListeners.delete(listener);
    },

    async refreshAuth(): Promise<void> {
      const current = socket;
      if (!current) return;
      const token = await getAccessToken();
      current.auth = { ...(current.auth as Record<string, unknown>), token };
      // Only a fresh handshake carries new credentials.
      if (current.connected) {
        current.disconnect();
        current.connect();
      }
    },
  };

  return client;
};