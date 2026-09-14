/**
 * usePresence  (F6)
 *
 * One presence source for three surfaces: the community member list, the chat
 * conversation list and the classroom participant list. They all read the same
 * Redis set through the same socket, because two presence systems disagreeing
 * about who is online is worse than having none.
 *
 * How it works:
 *
 *   fill    a batch HTTP lookup for the ids currently on screen
 *   update  live changes over the `/community` namespace
 *   expire  a presence entry has a TTL; a client that stops heartbeating fades
 *           to offline rather than staying online forever
 *
 * The heartbeat is explicit rather than inferred from the socket being open,
 * because a socket in a background tab stays open for hours while the person
 * is somewhere else entirely.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CommunityEvents, type Profile } from '@classroom/contracts';
import type { ProfileApi } from '../api/profileApi.js';
import type { SignalingTransport } from '../rtc/SfuClient.js';

const { COMMUNITY_CLIENT_EVENTS: CLIENT, COMMUNITY_SERVER_EVENTS: SERVER, PRESENCE_HEARTBEAT_MS } =
  CommunityEvents;

export interface UsePresenceOptions {
  api: ProfileApi;
  socket?: SignalingTransport;
  /** Ids to track. Changing this refills; keep it stable or memoised. */
  userIds: string[];
  /** Publish our own presence. False for a read-only view. */
  publish?: boolean;
  /** Set while in a lesson so others can see and join. */
  roomId?: string | null;
}

export interface UsePresenceResult {
  /** Missing ids resolve to 'offline' rather than undefined. */
  presence: Map<string, Profile.PresenceState>;
  entries: Map<string, Profile.PresenceEntry>;
  isOnline(userId: string): boolean;
  /** Someone in a lesson right now, with the room to join. */
  roomOf(userId: string): string | null;
  loading: boolean;
  /** Announce a state change immediately instead of waiting for the tick. */
  setSelfState(state: Profile.PresenceState): void;
}

export const usePresence = (options: UsePresenceOptions): UsePresenceResult => {
  const { api, socket, userIds, publish = true, roomId = null } = options;

  const [entries, setEntries] = useState<Map<string, Profile.PresenceEntry>>(new Map());
  const [loading, setLoading] = useState(false);
  const selfStateRef = useRef<Profile.PresenceState>('online');

  // Sorted and joined so a re-ordered array does not trigger a refill.
  const idKey = useMemo(() => [...userIds].sort().join(','), [userIds]);

  // -------------------------------------------------------------------------
  // Initial fill
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (userIds.length === 0) {
      setEntries(new Map());
      return;
    }

    const controller = new AbortController();
    setLoading(true);

    void api
      .getPresence(userIds, controller.signal)
      .then((result) => {
        setEntries(new Map(result.items.map((entry) => [entry.userId, entry])));
      })
      .catch(() => {
        // Presence is decoration. A failed lookup means everyone renders as
        // offline, which is a worse view but not a broken one.
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, idKey]);

  // -------------------------------------------------------------------------
  // Live updates
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!socket) return;

    const onChanged = (payload: CommunityEvents.CommunityServerPayloads['community:presence.changed']) => {
      setEntries((current) => {
        // Ignore people this view is not showing; a busy tenant emits far more
        // presence traffic than any single list cares about.
        if (!current.has(payload.userId) && !userIds.includes(payload.userId)) return current;
        const next = new Map(current);
        next.set(payload.userId, {
          userId: payload.userId as Profile.PresenceEntry['userId'],
          state: payload.state,
          roomId: payload.roomId as Profile.PresenceEntry['roomId'],
          updatedAt: new Date().toISOString(),
        });
        return next;
      });
    };

    socket.on(SERVER.presenceChanged, onChanged as (p: never) => void);
    return () => socket.off(SERVER.presenceChanged, onChanged as (p: never) => void);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, idKey]);

  // -------------------------------------------------------------------------
  // Our own heartbeat
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!socket || !publish) return;

    const beat = () => {
      void socket
        .emitWithAck(CLIENT.heartbeat, {
          state: roomId ? 'in-class' : selfStateRef.current,
          roomId,
        })
        .catch(() => undefined);
    };

    beat();
    // Comfortably inside PRESENCE_TTL_SEC, so one dropped beat does not make
    // the user flicker offline.
    const timer = setInterval(beat, PRESENCE_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [socket, publish, roomId]);

  const setSelfState = useCallback(
    (state: Profile.PresenceState) => {
      selfStateRef.current = state;
      if (!socket || !publish) return;
      void socket.emitWithAck(CLIENT.heartbeat, { state, roomId }).catch(() => undefined);
    },
    [socket, publish, roomId],
  );

  const presence = useMemo(() => {
    const map = new Map<string, Profile.PresenceState>();
    for (const id of userIds) map.set(id, entries.get(id)?.state ?? 'offline');
    return map;
  }, [userIds, entries]);

  return {
    presence,
    entries,
    isOnline: (userId) => {
      const state = entries.get(userId)?.state;
      return state === 'online' || state === 'in-class';
    },
    roomOf: (userId) => entries.get(userId)?.roomId ?? null,
    loading,
    setSelfState,
  };
};