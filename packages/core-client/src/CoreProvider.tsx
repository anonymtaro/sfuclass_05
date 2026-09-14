/**
 * CoreProvider  (F5)
 *
 * Owns the things that are singular per tab: the API client with its refresh
 * and trace ids, the authenticated session, the chat socket, and the room-to-
 * node resolver. Nothing below it constructs a transport of its own.
 *
 * What it deliberately does *not* own: the SfuClient.
 *
 * A tab has one HTTP client and one chat connection for its whole life. A
 * lesson does not — it starts when someone opens a room and ends when they
 * leave, and it drags in mediasoup-client, which is the largest dependency in
 * the product. Building it here would put mediasoup in the main bundle and make
 * the lazy route split in main.jsx meaningless. So the classroom route
 * assembles its own SfuClient from the pieces below, and mediasoup loads only
 * for people who actually join a lesson.
 *
 * Authentication shape, which everything else follows from: the access token
 * lives in memory only. It is never written to localStorage, because anything
 * that can read localStorage can read the token. Persistence is the refresh
 * cookie, which is httpOnly and which JavaScript therefore cannot touch. A
 * reload restores the session by calling refresh once on mount.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { ApiError } from '@classroom/contracts';

import { createHttpClient, type AuthProvider, type HttpClient } from './http/httpClient.js';
import { createSocketClient, type SocketClient } from './socket/socketClient.js';
import { createNodeResolver, type NodeResolver } from './rtc/nodeResolver.js';

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface Session {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  /** Tenant role, not the room role — a teacher is still a learner elsewhere. */
  role: 'owner' | 'teacher' | 'learner';
  tenantId: string;
}

export type AuthStatus = 'restoring' | 'authenticated' | 'anonymous';

interface RefreshResponse {
  accessToken: string;
  user: Session;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface CoreContextValue {
  http: HttpClient;
  nodeResolver: NodeResolver;
  /** The `/chat` connection. Null until there is a session to authenticate it. */
  chatSocket: SocketClient | null;
  session: Session | null;
  status: AuthStatus;
  release: string;
  apiUrl: string;
  wsUrl: string;
  /** Handed to SfuClient and to any socket the classroom route opens. */
  getAccessToken(): string | null;
  signIn(credentials: { email: string; password: string }): Promise<Session>;
  signOut(): Promise<void>;
}

const CoreContext = createContext<CoreContextValue | null>(null);

export const useCore = (): CoreContextValue => {
  const value = useContext(CoreContext);
  if (!value) throw new Error('useCore must be used inside <CoreProvider>');
  return value;
};

/** Convenience accessors, so a component that needs one thing imports one thing. */
export const useHttp = (): HttpClient => useCore().http;
export const useSession = (): Session | null => useCore().session;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface CoreProviderProps {
  apiUrl: string;
  wsUrl: string;
  release: string;
  children: ReactNode;
  /** Where to send someone whose session expired. Defaults to no redirect. */
  onSessionExpired?(): void;
}

/** Double-submit token for the cookie-authenticated refresh route. */
const readCsrfCookie = (): string | null => {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
};

export function CoreProvider({
  apiUrl,
  wsUrl,
  release,
  children,
  onSessionExpired,
}: CoreProviderProps) {
  // A ref, not state: the token is read inside callbacks that must not go stale
  // between renders, and changing it should never trigger one.
  const accessTokenRef = useRef<string | null>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>('restoring');

  const sessionExpiredRef = useRef(onSessionExpired);
  sessionExpiredRef.current = onSessionExpired;

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  const http = useMemo<HttpClient>(() => {
    const auth: AuthProvider = {
      getAccessToken: () => accessTokenRef.current,

      /**
       * The refresh cookie is sent automatically; this route is the one place
       * that uses cookie auth, which is why it is also the only route that
       * needs the CSRF token. httpClient serialises concurrent callers onto one
       * call, so a burst of 401s produces one refresh and the rotating token
       * does not invalidate itself.
       */
      async refresh() {
        try {
          const client = createHttpClient({ baseUrl: apiUrl });
          const result = (await client.post(
            '/auth/refresh',
            {},
            { anonymous: true, headers: csrfHeader() },
          )) as RefreshResponse;

          accessTokenRef.current = result.accessToken;
          setSession(result.user);
          setStatus('authenticated');
          return result.accessToken;
        } catch {
          return null;
        }
      },

      onSessionExpired() {
        accessTokenRef.current = null;
        setSession(null);
        setStatus('anonymous');
        sessionExpiredRef.current?.();
      },

      getCsrfToken: readCsrfCookie,
    };

    return createHttpClient({
      baseUrl: apiUrl,
      auth,
      // Web sends the refresh cookie; apps/mobile keeps tokens in secure
      // storage and passes 'omit' instead.
      credentials: 'include',
      defaultHeaders: { 'x-client-release': release },
    });
  }, [apiUrl, release]);

  // -------------------------------------------------------------------------
  // Room to node resolution (F1)
  // -------------------------------------------------------------------------

  // Lives here rather than in the classroom route so its cache survives
  // leaving and rejoining a lesson — a reload should not cost a round trip.
  const nodeResolver = useMemo(() => createNodeResolver({ http }), [http]);

  // -------------------------------------------------------------------------
  // Chat socket (F6)
  // -------------------------------------------------------------------------

  const [chatSocket, setChatSocket] = useState<SocketClient | null>(null);

  useEffect(() => {
    if (status !== 'authenticated') return undefined;

    const socket = createSocketClient({
      namespace: '/chat',
      getAccessToken: () => accessTokenRef.current,
    });

    let cancelled = false;
    void socket
      .connect(wsUrl, {})
      .then(() => {
        if (!cancelled) setChatSocket(socket);
      })
      .catch(() => {
        // A chat socket that will not open must not take the app down with it.
        // Everything else keeps working; the dock shows itself as offline.
      });

    return () => {
      cancelled = true;
      socket.disconnect();
      setChatSocket(null);
    };
  }, [status, wsUrl]);

  // -------------------------------------------------------------------------
  // Restore on mount
  // -------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const result = (await http.post(
          '/auth/refresh',
          {},
          { anonymous: true, headers: csrfHeader() },
        )) as RefreshResponse;

        if (cancelled) return;
        accessTokenRef.current = result.accessToken;
        setSession(result.user);
        setStatus('authenticated');
      } catch {
        // No refresh cookie, or it expired. Not an error — most first visits
        // land here.
        if (!cancelled) setStatus('anonymous');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [http]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const signIn = useCallback<CoreContextValue['signIn']>(
    async (credentials) => {
      const result = (await http.post('/auth/login', credentials, {
        anonymous: true,
        headers: csrfHeader(),
      })) as RefreshResponse;

      accessTokenRef.current = result.accessToken;
      setSession(result.user);
      setStatus('authenticated');
      return result.user;
    },
    [http],
  );

  const signOut = useCallback<CoreContextValue['signOut']>(async () => {
    try {
      await http.post('/auth/logout', {}, { headers: csrfHeader() });
    } catch (cause) {
      // A logout that fails server-side still has to clear the client, or the
      // user stays signed in on a machine they just tried to leave.
      if (!ApiError.is(cause)) throw cause;
    } finally {
      accessTokenRef.current = null;
      nodeResolver.clear();
      setSession(null);
      setStatus('anonymous');
    }
  }, [http, nodeResolver]);

  const value = useMemo<CoreContextValue>(
    () => ({
      http,
      nodeResolver,
      chatSocket,
      session,
      status,
      release,
      apiUrl,
      wsUrl,
      getAccessToken: () => accessTokenRef.current,
      signIn,
      signOut,
    }),
    [http, nodeResolver, chatSocket, session, status, release, apiUrl, wsUrl, signIn, signOut],
  );

  return <CoreContext.Provider value={value}>{children}</CoreContext.Provider>;
}

const csrfHeader = (): Record<string, string> => {
  const token = readCsrfCookie();
  return token ? { 'x-csrf-token': token } : {};
};

export default CoreProvider;