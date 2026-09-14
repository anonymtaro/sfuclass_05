/**
 * Profile API  (F6)
 *
 * The profile is the anchor for direct messages, so this file and chatApi are
 * used together: a profile card resolves here, and its Message action calls
 * `chatApi.openDirect()`.
 *
 * `canMessage` on a PublicProfile is computed by the server and must be treated
 * as authoritative. Only the server can see both block lists and the target's
 * DM policy, so a client that tries to work it out will eventually be wrong in
 * the one direction that matters — showing a button that fails.
 */

import { Profile } from '@classroom/contracts';
import type { z } from 'zod';
import type { HttpClient } from '../http/httpClient.js';

export interface ProfileApi {
  getOwn(signal?: AbortSignal): Promise<z.infer<typeof Profile.OwnProfileSchema>>;
  get(userId: string, signal?: AbortSignal): Promise<z.infer<typeof Profile.PublicProfileSchema>>;
  getByHandle(
    handle: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Profile.PublicProfileSchema>>;

  update(
    input: z.infer<typeof Profile.UpdateOwnProfileSchema>,
  ): Promise<z.infer<typeof Profile.OwnProfileSchema>>;
  updatePrivacy(
    input: z.infer<typeof Profile.UpdatePrivacySchema>,
  ): Promise<z.infer<typeof Profile.PrivacySettingsSchema>>;
  updateNotifications(
    input: z.infer<typeof Profile.UpdateNotificationsSchema>,
  ): Promise<z.infer<typeof Profile.NotificationSettingsSchema>>;
  /** The asset must already be `ready`; upload it through mediaApi first. */
  setAvatar(assetId: string): Promise<z.infer<typeof Profile.OwnProfileSchema>>;
  removeAvatar(): Promise<z.infer<typeof Profile.OwnProfileSchema>>;

  /** Mention autocomplete and people search. Two characters minimum. */
  search(
    query: z.infer<typeof Profile.ProfileSearchQuerySchema>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Profile.ProfileSuggestionListSchema>>;

  listBlocks(
    query?: { cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Profile.BlockListSchema>>;
  block(input: z.infer<typeof Profile.BlockUserSchema>): Promise<z.infer<typeof Profile.BlockSchema>>;
  unblock(userId: string): Promise<void>;
  report(
    input: z.infer<typeof Profile.ReportUserSchema>,
  ): Promise<z.infer<typeof Profile.ReportReceiptSchema>>;

  /**
   * Batch presence lookup for a member list. Live changes arrive over the
   * community socket; this is the initial fill only.
   */
  getPresence(
    userIds: string[],
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Profile.PresenceListSchema>>;
}

export const createProfileApi = (http: HttpClient): ProfileApi => ({
  getOwn: (signal) => http.get('/profiles/me', { schema: Profile.OwnProfileSchema, signal }),

  get: (userId, signal) =>
    http.get(`/profiles/${encodeURIComponent(userId)}`, {
      schema: Profile.PublicProfileSchema,
      signal,
    }),

  getByHandle: (handle, signal) =>
    http.get(`/profiles/by-handle/${encodeURIComponent(handle)}`, {
      schema: Profile.PublicProfileSchema,
      signal,
    }),

  update: (input) =>
    http.patch('/profiles/me', input, { schema: Profile.OwnProfileSchema }),

  updatePrivacy: (input) =>
    http.patch('/profiles/me/privacy', input, { schema: Profile.PrivacySettingsSchema }),

  updateNotifications: (input) =>
    http.patch('/profiles/me/notifications', input, {
      schema: Profile.NotificationSettingsSchema,
    }),

  setAvatar: (assetId) =>
    http.put('/profiles/me/avatar', { assetId }, { schema: Profile.OwnProfileSchema }),

  removeAvatar: () =>
    http.delete('/profiles/me/avatar', { schema: Profile.OwnProfileSchema }),

  search: (query, signal) =>
    http.get('/profiles/search', {
      schema: Profile.ProfileSuggestionListSchema,
      query: { q: query.q, scopeId: query.scopeId, limit: query.limit },
      signal,
      // Typed into a mention box: a stale response is worthless, so fail fast
      // rather than retrying behind the user's next keystroke.
      retry: { attempts: 1 },
      timeoutMs: 5_000,
    }),

  listBlocks: (query = {}, signal) =>
    http.get('/profiles/me/blocks', {
      schema: Profile.BlockListSchema,
      query: { cursor: query.cursor, limit: query.limit },
      signal,
    }),

  /**
   * Blocking is enforced server-side on send, in both directions. Existing
   * history stays visible — removing someone else's words is moderation, not
   * blocking.
   */
  block: (input) =>
    http.post('/profiles/me/blocks', input, { schema: Profile.BlockSchema }),

  unblock: async (userId) => {
    await http.delete(`/profiles/me/blocks/${encodeURIComponent(userId)}`);
  },

  report: (input) =>
    http.post('/profiles/reports', input, { schema: Profile.ReportReceiptSchema }),

  getPresence: (userIds, signal) =>
    http.post(
      '/profiles/presence',
      { userIds },
      { schema: Profile.PresenceListSchema, signal, retry: { attempts: 1 } },
    ),
});