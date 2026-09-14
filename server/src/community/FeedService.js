// classroom-app/server/src/community/FeedService.js
/**
 * Feed and threads  (F2)  [NEW]
 *
 * Reading a space, opening a thread, posting a reply.
 *
 * The feed is cursor paginated, never offset. An offset feed shifts under the
 * reader every time somebody posts — which in a busy space is constantly, and
 * produces the effect where scrolling shows you the same thread twice and skips
 * the one between them.
 *
 * The cursor carries its sort order. A cursor issued for "active" is
 * meaningless against "recent", and silently accepting it would page through
 * the wrong column; Thread.feed rejects the mismatch rather than returning
 * plausible nonsense.
 */

import { logger } from '../observability/logger.js';
import * as Threads from './models/Thread.js';
import * as Posts from './models/Post.js';
import * as Memberships from './models/Membership.js';
import * as Spaces from './models/Space.js';
import { assertMember } from './SpaceService.js';

const log = logger.child({ component: 'feed' });

const EXCERPT_LENGTH = 280;

const excerpt = (body) =>
  body.length <= EXCERPT_LENGTH ? body : `${body.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…`;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const getFeed = async ({ viewerId, spaceId, ...query }) => {
  // A space feed requires membership; the cross-space feed is already scoped
  // to the viewer's spaces by the query itself.
  if (spaceId) await assertMember({ spaceId, userId: viewerId });

  return Threads.feed({ viewerId, spaceId, ...query });
};

/**
 * A thread with its first page of replies. One call, because rendering a thread
 * needs both and two round trips is two spinners.
 */
export const getThread = async ({ threadId, viewerId, cursor, limit = 25 }) => {
  const thread = await Threads.findById(threadId, viewerId);
  if (!thread || thread.deletedAt) {
    throw Object.assign(new Error('thread not found'), { code: 'not_found' });
  }

  await assertMember({ spaceId: thread.spaceId, userId: viewerId });

  const posts = await Posts.listByThread({ threadId, cursor, limit });

  // Opening a thread is reading it. Fire and forget: a failed read marker is
  // a wrong badge, not a broken page.
  void Memberships.markRead({ spaceId: thread.spaceId, userId: viewerId }).catch(() => undefined);

  return { ...thread, posts };
};

export const listPosts = async ({ threadId, viewerId, cursor, limit }) => {
  const thread = await Threads.findById(threadId, viewerId);
  if (!thread) throw Object.assign(new Error('thread not found'), { code: 'not_found' });

  await assertMember({ spaceId: thread.spaceId, userId: viewerId });
  return Posts.listByThread({ threadId, cursor, limit });
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const assertCanPost = async ({ spaceId, userId }) => {
  const [space, membership] = await Promise.all([
    Spaces.findById(spaceId, userId),
    Memberships.find({ spaceId, userId }),
  ]);

  if (!space) throw Object.assign(new Error('space not found'), { code: 'not_found' });

  const verdict = Memberships.canPost(membership, space);
  if (!verdict.allowed) {
    throw Object.assign(new Error(verdict.reason ?? 'you cannot post here'), { code: verdict.code });
  }

  return { space, membership };
};

export const createThread = async ({ viewerId, spaceId, kind, title, body, tags, attachmentIds = [], mentions = [] }) => {
  await assertCanPost({ spaceId, userId: viewerId });

  const attachments = await resolveAttachments(attachmentIds, viewerId);

  const thread = await Threads.insert({
    spaceId,
    authorId: viewerId,
    kind,
    title,
    body,
    tags,
    attachments,
  });

  // The author follows their own thread, so replies reach them without them
  // having to opt in to a conversation they started.
  await Threads.follow({ threadId: thread.threadId, userId: viewerId, following: true });

  broadcast(spaceId, 'community:thread.created', {
    spaceId,
    threadId: thread.threadId,
    title: thread.title,
    author: thread.author,
    createdAt: thread.createdAt,
  });

  if (mentions.length > 0) await notifyMentions({ mentions, thread, actorId: viewerId, body });

  log.info({ threadId: thread.threadId, spaceId, viewerId }, 'thread created');
  return thread;
};

export const createPost = async ({ viewerId, threadId, body, replyToPostId, attachmentIds = [], mentions = [], idempotencyKey }) => {
  const thread = await Threads.findById(threadId, viewerId);
  if (!thread || thread.deletedAt) {
    throw Object.assign(new Error('thread not found'), { code: 'not_found' });
  }
  if (thread.locked) {
    throw Object.assign(new Error('this thread is locked'), { code: 'conflict' });
  }

  await assertCanPost({ spaceId: thread.spaceId, userId: viewerId });

  const attachments = await resolveAttachments(attachmentIds, viewerId);

  const post = await Posts.insert({
    threadId,
    authorId: viewerId,
    body,
    replyToPostId,
    mentions,
    attachments,
    idempotencyKey,
  });

  // Replying is following, unless they have explicitly unfollowed.
  await Threads.follow({ threadId, userId: viewerId, following: true }).catch(() => undefined);

  broadcast(thread.spaceId, 'community:post.created', {
    spaceId: thread.spaceId,
    threadId,
    postId: post.postId,
    author: post.author,
    excerpt: excerpt(body),
    mentionsViewer: false,
    postCount: thread.postCount + 1,
    createdAt: post.createdAt,
  });

  const { notifyThreadReply } = await import('./NotificationService.js');
  void notifyThreadReply({ threadId, actorId: viewerId, excerpt: excerpt(body) }).catch(() => undefined);

  if (mentions.length > 0) await notifyMentions({ mentions, thread, actorId: viewerId, body, postId: post.postId });

  return post;
};

export const editThread = async ({ viewerId, threadId, patch }) => {
  const thread = await Threads.findById(threadId, viewerId);
  if (!thread) throw Object.assign(new Error('thread not found'), { code: 'not_found' });

  const membership = await Memberships.find({ spaceId: thread.spaceId, userId: viewerId });
  const isAuthor = thread.author?.userId === viewerId;

  // A moderator may edit, but only to remove something. Rewriting someone
  // else's post under their name is not moderation.
  if (!isAuthor && !Memberships.isModerator(membership)) {
    throw Object.assign(new Error('you can only edit your own posts'), { code: 'forbidden' });
  }

  const updated = await Threads.update(threadId, patch, viewerId);
  broadcast(thread.spaceId, 'community:thread.updated', {
    spaceId: thread.spaceId,
    threadId,
    change: 'edited',
    actor: thread.author,
  });
  return updated;
};

export const editPost = async ({ viewerId, postId, body }) => {
  const post = await Posts.findById(postId);
  if (!post) throw Object.assign(new Error('post not found'), { code: 'not_found' });
  if (post.author?.userId !== viewerId) {
    throw Object.assign(new Error('you can only edit your own posts'), { code: 'forbidden' });
  }
  return Posts.update(postId, { body });
};

export const acceptAnswer = async ({ viewerId, threadId, postId }) => {
  const thread = await Threads.findById(threadId, viewerId);
  if (!thread) throw Object.assign(new Error('thread not found'), { code: 'not_found' });

  const membership = await Memberships.find({ spaceId: thread.spaceId, userId: viewerId });
  // The person who asked decides what answered it. A moderator can too, for
  // the questions whose authors never come back.
  if (thread.author?.userId !== viewerId && !Memberships.isModerator(membership)) {
    throw Object.assign(new Error('only the author can accept an answer'), { code: 'forbidden' });
  }

  await Posts.acceptAnswer({ threadId, postId });
  return Threads.findById(threadId, viewerId);
};

export const react = async ({ viewerId, targetType, targetId, emoji, action }) => {
  const spaceId =
    targetType === 'thread'
      ? (await Threads.findById(targetId, viewerId))?.spaceId
      : (await Threads.findById((await Posts.findById(targetId))?.threadId, viewerId))?.spaceId;

  if (!spaceId) throw Object.assign(new Error('not found'), { code: 'not_found' });
  await assertMember({ spaceId, userId: viewerId });

  const reactions = await Posts.react({ targetType, targetId, userId: viewerId, emoji, action });

  broadcast(spaceId, 'community:reaction.changed', {
    targetType,
    targetId,
    emoji,
    userId: viewerId,
    action,
    count: reactions.find((entry) => entry.emoji === emoji)?.count ?? 0,
  });

  return reactions;
};

export const follow = async ({ viewerId, threadId, following }) => {
  const thread = await Threads.findById(threadId, viewerId);
  if (!thread) throw Object.assign(new Error('thread not found'), { code: 'not_found' });
  await assertMember({ spaceId: thread.spaceId, userId: viewerId });
  return Threads.follow({ threadId, userId: viewerId, following });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attachments must already be `ready` and must belong to the person posting.
 * Without the ownership check, a guessed asset id would let anyone attach
 * somebody else's file to their own post.
 */
const resolveAttachments = async (assetIds, userId) => {
  if (assetIds.length === 0) return [];

  const { getAssetsForOwner } = await import('../media/UploadService.js');
  const assets = await getAssetsForOwner({ assetIds, userId });

  const notReady = assets.filter((asset) => asset.status !== 'ready');
  if (notReady.length > 0) {
    throw Object.assign(new Error('one or more attachments are still processing'), {
      code: 'asset_not_ready',
    });
  }
  if (assets.length !== assetIds.length) {
    throw Object.assign(new Error('unknown attachment'), { code: 'not_found' });
  }

  return assets.map((asset) => ({
    assetId: asset.assetId,
    kind: asset.kind,
    fileName: asset.fileName,
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes,
    thumbnailUrl: asset.thumbnailUrl ?? null,
    url: null, // signed when the thread is read
  }));
};

const notifyMentions = async ({ mentions, thread, actorId, body, postId = null }) => {
  const { notifyMany } = await import('./NotificationService.js');
  // Someone mentioning themselves is not a notification.
  const recipients = mentions.filter((userId) => userId !== actorId);
  if (recipients.length === 0) return;

  await notifyMany({
    userIds: recipients,
    type: 'thread.mention',
    title: `You were mentioned in “${thread.title}”`,
    body: excerpt(body),
    href: `/spaces/${thread.spaceId}/threads/${thread.threadId}${postId ? `#${postId}` : ''}`,
    actorId,
    data: { threadId: thread.threadId, postId },
  });
};

const broadcast = (spaceId, event, payload) => {
  void import('../realtime/presenceGateway.js')
    .then(({ broadcastToSpace }) => broadcastToSpace(spaceId, event, payload))
    .catch(() => undefined);
};

export default { getFeed, getThread, createThread, createPost, react, follow, acceptAnswer };