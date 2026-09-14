/**
 * useChat  (F6)
 *
 * One hook for both surfaces, because a direct message and a public channel
 * message differ only in what they are addressed to. Pass a ChatTarget and this
 * handles the rest.
 *
 * The hard part is not fetching, it is reconciliation. A sent message exists
 * three times: as an optimistic bubble the moment the user presses enter, as
 * the HTTP response, and as the socket echo that reaches every other client
 * including this one. All three carry the same `clientMessageId`, and that is
 * what collapses them into one bubble instead of three.
 *
 * Delivery states a bubble can be in:
 *
 *   sending   optimistic, no server acknowledgement yet
 *   sent      the server has it; the id is now the real one
 *   failed    the send did not survive its retries; `retry()` is available
 *
 * Messages are held oldest-first, which is the order they render in. The API
 * returns newest-first because that is the efficient direction for a keyset
 * query, so the first page is reversed on arrival.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type ActorRef, type Chat } from '@classroom/contracts';
import { ChatEvents } from '@classroom/contracts';
import type { ChatApi } from '../api/chatApi.js';
import type { SignalingTransport } from '../rtc/SfuClient.js';

const { CHAT_CLIENT_EVENTS: CLIENT, CHAT_SERVER_EVENTS: SERVER, TYPING_TTL_MS } = ChatEvents;

export type DeliveryState = 'sending' | 'sent' | 'failed';

export type ChatMessageView = Chat.Message & {
  delivery: DeliveryState;
};

export interface UseChatOptions {
  api: ChatApi;
  /** The `/chat` namespace connection. Omit to run HTTP-only. */
  socket?: SignalingTransport;
  target: Chat.ChatTarget;
  /** Needed to render an optimistic bubble before the server replies. */
  self: ActorRef;
  pageSize?: number;
  /** Mark messages read as they arrive while the view is focused. */
  autoMarkRead?: boolean;
}

export interface UseChatResult {
  messages: ChatMessageView[];
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  error: ApiError | null;
  /** User ids currently typing, excluding the local user. */
  typingUserIds: string[];
  /** Set when slow mode or a rate limit is holding the composer. */
  throttledUntil: number | null;

  send(input: { body: string; attachmentIds?: string[]; replyToId?: string }): Promise<void>;
  retry(clientMessageId: string): Promise<void>;
  edit(messageId: string, body: string): Promise<void>;
  remove(messageId: string): Promise<void>;
  react(messageId: string, emoji: string, action?: 'add' | 'remove'): Promise<void>;
  loadOlder(): Promise<void>;
  markRead(): void;
  setTyping(typing: boolean): void;
}

const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/** Same target, structurally. Targets are compared by value, not identity. */
const sameTarget = (a: Chat.ChatTarget, b: Chat.ChatTarget): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export const useChat = (options: UseChatOptions): UseChatResult => {
  const { api, socket, target, self, pageSize = 30, autoMarkRead = true } = options;

  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [typing, setTypingUsers] = useState<Map<string, number>>(new Map());
  const [throttledUntil, setThrottledUntil] = useState<number | null>(null);

  const cursorRef = useRef<string | null>(null);
  const lastTypingSentRef = useRef(0);
  const targetKey = useMemo(() => JSON.stringify(target), [target]);

  // -------------------------------------------------------------------------
  // Initial page
  // -------------------------------------------------------------------------

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setMessages([]);
    cursorRef.current = null;

    void api
      .listMessages(target, { limit: pageSize, order: 'desc' }, controller.signal)
      .then((page) => {
        // The API returns newest-first; the view renders oldest-first.
        setMessages(page.items.reverse().map((m) => ({ ...m, delivery: 'sent' as const })));
        cursorRef.current = page.nextCursor;
        setHasMore(page.hasMore);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(ApiError.is(cause) ? cause : null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, targetKey, pageSize]);

  // -------------------------------------------------------------------------
  // Live updates
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!socket) return;

    void socket.emitWithAck(CLIENT.subscribe, { targets: [target] });

    const onNew = (payload: ChatEvents.ChatServerPayloads['chat:message.new']) => {
      if (!sameTarget(payload.message.target, target)) return;
      setMessages((current) => {
        // Our own message coming back: replace the optimistic bubble rather
        // than appending a duplicate.
        const key = payload.clientMessageId ?? payload.message.clientMessageId;
        if (key) {
          const index = current.findIndex((m) => m.clientMessageId === key);
          if (index >= 0) {
            const next = [...current];
            next[index] = { ...payload.message, delivery: 'sent' };
            return next;
          }
        }
        if (current.some((m) => m.messageId === payload.message.messageId)) return current;
        return [...current, { ...payload.message, delivery: 'sent' as const }];
      });
    };

    const onUpdated = (payload: { message: Chat.Message }) => {
      setMessages((current) =>
        current.map((m) =>
          m.messageId === payload.message.messageId
            ? { ...payload.message, delivery: 'sent' as const }
            : m,
        ),
      );
    };

    const onDeleted = (payload: ChatEvents.ChatServerPayloads['chat:message.deleted']) => {
      setMessages((current) =>
        current.map((m) =>
          m.messageId === payload.messageId
            ? { ...m, deletedAt: payload.deletedAt, deletedBy: payload.deletedBy, body: '' }
            : m,
        ),
      );
    };

    const onReaction = (payload: ChatEvents.ChatServerPayloads['chat:message.reaction']) => {
      setMessages((current) =>
        current.map((m) => {
          if (m.messageId !== payload.messageId) return m;
          const others = m.reactions.filter((r) => r.emoji !== payload.emoji);
          if (payload.count === 0) return { ...m, reactions: others };
          const mine = payload.userId === self.userId;
          const existing = m.reactions.find((r) => r.emoji === payload.emoji);
          return {
            ...m,
            reactions: [
              ...others,
              {
                emoji: payload.emoji,
                count: payload.count,
                reacted: mine ? payload.action === 'add' : (existing?.reacted ?? false),
              },
            ],
          };
        }),
      );
    };

    const onTyping = (payload: ChatEvents.ChatServerPayloads['chat:typing.changed']) => {
      if (!sameTarget(payload.target, target) || payload.userId === self.userId) return;
      setTypingUsers((current) => {
        const next = new Map(current);
        if (payload.typing) next.set(payload.userId, Date.parse(payload.expiresAt));
        else next.delete(payload.userId);
        return next;
      });
    };

    const onThrottled = (payload: ChatEvents.ChatServerPayloads['chat:throttled']) => {
      if (!sameTarget(payload.target, target)) return;
      setThrottledUntil(Date.now() + payload.retryAfterSec * 1000);
    };

    // Attachments finish scanning after the message is already on screen.
    const onAttachmentReady = (
      payload: ChatEvents.ChatServerPayloads['chat:attachment.ready'],
    ) => {
      setMessages((current) =>
        current.map((m) =>
          m.messageId === payload.messageId
            ? {
                ...m,
                attachments: m.attachments.map((a) =>
                  a.assetId === payload.assetId
                    ? {
                        ...a,
                        status: payload.status === 'ready' ? 'ready' : 'failed',
                        downloadUrl: payload.downloadUrl,
                        previewUrl: payload.previewUrl,
                      }
                    : a,
                ),
              }
            : m,
        ),
      );
    };

    socket.on(SERVER.messageNew, onNew as (p: never) => void);
    socket.on(SERVER.messageUpdated, onUpdated as (p: never) => void);
    socket.on(SERVER.messageDeleted, onDeleted as (p: never) => void);
    socket.on(SERVER.reactionChanged, onReaction as (p: never) => void);
    socket.on(SERVER.typingChanged, onTyping as (p: never) => void);
    socket.on(SERVER.throttled, onThrottled as (p: never) => void);
    socket.on(SERVER.attachmentReady, onAttachmentReady as (p: never) => void);

    return () => {
      socket.off(SERVER.messageNew, onNew as (p: never) => void);
      socket.off(SERVER.messageUpdated, onUpdated as (p: never) => void);
      socket.off(SERVER.messageDeleted, onDeleted as (p: never) => void);
      socket.off(SERVER.reactionChanged, onReaction as (p: never) => void);
      socket.off(SERVER.typingChanged, onTyping as (p: never) => void);
      socket.off(SERVER.throttled, onThrottled as (p: never) => void);
      socket.off(SERVER.attachmentReady, onAttachmentReady as (p: never) => void);
      void socket.emitWithAck(CLIENT.unsubscribe, { targets: [target] });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, targetKey, self.userId]);

  /** Typing indicators expire on their own; nothing sends a stop event. */
  useEffect(() => {
    if (typing.size === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setTypingUsers((current) => {
        const next = new Map([...current].filter(([, expiry]) => expiry > now));
        return next.size === current.size ? current : next;
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, [typing.size]);

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  const deliver = useCallback(
    async (payload: Chat.SendMessage) => {
      try {
        const saved = await api.send(payload);
        setMessages((current) =>
          current.map((m) =>
            m.clientMessageId === payload.clientMessageId
              ? { ...saved, delivery: 'sent' as const }
              : m,
          ),
        );
      } catch (cause) {
        setMessages((current) =>
          current.map((m) =>
            m.clientMessageId === payload.clientMessageId
              ? { ...m, delivery: 'failed' as const }
              : m,
          ),
        );
        if (ApiError.is(cause)) {
          setError(cause);
          if (cause.retryAfter) setThrottledUntil(Date.now() + cause.retryAfter * 1000);
        }
      }
    },
    [api],
  );

  const send = useCallback<UseChatResult['send']>(
    async (input) => {
      const clientMessageId = newId();
      const payload: Chat.SendMessage = {
        target,
        body: input.body,
        attachmentIds: (input.attachmentIds ?? []) as Chat.SendMessage['attachmentIds'],
        mentions: [],
        ...(input.replyToId ? { replyToId: input.replyToId as Chat.MessageId } : {}),
        clientMessageId,
      };

      // The bubble appears before the request leaves. If it fails it stays,
      // marked, so nobody loses what they wrote.
      const optimistic: ChatMessageView = {
        messageId: clientMessageId as Chat.MessageId,
        target,
        kind: 'text',
        author: self,
        body: input.body,
        mentions: [],
        attachments: [],
        replyToId: (input.replyToId ?? null) as Chat.MessageId | null,
        reactions: [],
        clientMessageId,
        editedAt: null,
        deletedAt: null,
        deletedBy: null,
        createdAt: new Date().toISOString(),
        delivery: 'sending',
      };

      setMessages((current) => [...current, optimistic]);
      await deliver(payload);
    },
    [target, self, deliver],
  );

  const retry = useCallback<UseChatResult['retry']>(
    async (clientMessageId) => {
      const message = messages.find((m) => m.clientMessageId === clientMessageId);
      if (!message) return;
      setMessages((current) =>
        current.map((m) =>
          m.clientMessageId === clientMessageId ? { ...m, delivery: 'sending' as const } : m,
        ),
      );
      // Same clientMessageId: the server recognises the retry as the same
      // message rather than creating a second one.
      await deliver({
        target,
        body: message.body,
        attachmentIds: message.attachments.map((a) => a.assetId),
        mentions: [],
        clientMessageId,
      });
    },
    [messages, target, deliver],
  );

  // -------------------------------------------------------------------------
  // Everything else
  // -------------------------------------------------------------------------

  const loadOlder = useCallback(async () => {
    if (!cursorRef.current || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api.listMessages(target, {
        cursor: cursorRef.current,
        limit: pageSize,
        order: 'desc',
      });
      setMessages((current) => [
        ...page.items.reverse().map((m) => ({ ...m, delivery: 'sent' as const })),
        ...current,
      ]);
      cursorRef.current = page.nextCursor;
      setHasMore(page.hasMore);
    } catch (cause) {
      if (ApiError.is(cause)) setError(cause);
    } finally {
      setLoadingOlder(false);
    }
  }, [api, target, pageSize, loadingOlder]);

  const markRead = useCallback(() => {
    const last = messages.at(-1);
    if (!last || last.delivery !== 'sent') return;
    void api.markRead(target, last.messageId).catch(() => undefined);
  }, [api, target, messages]);

  useEffect(() => {
    if (autoMarkRead) markRead();
  }, [autoMarkRead, markRead]);

  /**
   * Throttled to one event per TTL window. A keystroke-per-event would be the
   * chattiest thing in the product by an order of magnitude.
   */
  const setTyping = useCallback(
    (isTyping: boolean) => {
      if (!socket) return;
      const now = Date.now();
      if (isTyping && now - lastTypingSentRef.current < TYPING_TTL_MS / 2) return;
      lastTypingSentRef.current = now;
      void socket.emitWithAck(CLIENT.typing, { target, typing: isTyping });
    },
    [socket, target],
  );

  return {
    messages,
    loading,
    loadingOlder,
    hasMore,
    error,
    typingUserIds: [...typing.keys()],
    throttledUntil,
    send,
    retry,
    edit: async (messageId, body) => {
      const saved = await api.edit(messageId, body);
      setMessages((current) =>
        current.map((m) => (m.messageId === messageId ? { ...saved, delivery: 'sent' } : m)),
      );
    },
    remove: async (messageId) => {
      await api.remove(messageId);
      setMessages((current) =>
        current.map((m) =>
          m.messageId === messageId
            ? { ...m, deletedAt: new Date().toISOString(), body: '' }
            : m,
        ),
      );
    },
    react: async (messageId, emoji, action = 'add') => {
      await api.react(messageId, { emoji, action });
    },
    loadOlder,
    markRead,
    setTyping,
  };
};