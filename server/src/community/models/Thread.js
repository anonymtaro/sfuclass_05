// classroom-app/server/src/community/models/Thread.js
/**
 * Thread row access  (F2)  [NEW]
 *
 * The opening post lives on the thread row, not as the first Post. That looks
 * like duplication and is not: the feed shows every thread with its title and
 * an excerpt, and joining to a posts table for the first row of each would make
 * the most-read query in the product a join over the largest table in it.
 *
 * `last_post_at` and `post_count` are denormalised for the same reason. They
 * are maintained by Post.insert in the same transaction, so they cannot drift.
 */

import { pool } from '../../db/pool.js';

export const TABLE = 'threads';

export const rowToThread = (row) => ({
  threadId: row.id,
  spaceId: row.space_id,
  kind: row.kind,
  title: row.title,
  body: row.body,
  author: row.author_id
    ? { userId: row.author_id, displayName: row.author_name ?? '', avatarUrl: row.author_avatar ?? null }
    : null,
  attachments: row.attachments ?? [],
  tags: row.tags ?? [],
  reactions: row.reactions ?? [],
  postCount: Number(row.post_count ?? 0),
  participantCount: Number(row.participant_count ?? 0),
  lastPostAt: row.last_post_at?.toISOString() ?? null,
  lastPostBy: row.last_poster_id
    ? { userId: row.last_poster_id, displayName: row.last_poster_name ?? '', avatarUrl: null }
    : null,
  pinned: row.pinned,
  locked: row.locked,
  resolved: row.resolved,
  unread: row.viewer_unread ?? false,
  following: row.viewer_following ?? false,
  editedAt: row.edited_at?.toISOString() ?? null,
  deletedAt: row.deleted_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const SELECT = `
  SELECT t.*,
         a.display_name AS author_name,
         a.avatar_url   AS author_avatar,
         lp.display_name AS last_poster_name,
         (m.last_read_at IS NULL OR t.last_post_at > m.last_read_at) AS viewer_unread,
         (f.user_id IS NOT NULL) AS viewer_following
    FROM threads t
    LEFT JOIN users a  ON a.id = t.author_id
    LEFT JOIN users lp ON lp.id = t.last_poster_id
    LEFT JOIN space_memberships m ON m.space_id = t.space_id AND m.user_id = $1
    LEFT JOIN thread_follows f ON f.thread_id = t.id AND f.user_id = $1
`;

export const findById = async (threadId, viewerId = null, client = pool) => {
  const { rows } = await client.query(`${SELECT} WHERE t.id = $2`, [viewerId, threadId]);
  return rows[0] ? rowToThread(rows[0]) : null;
};

/**
 * Sort orders, and the cursor column each one pages on. A cursor is only
 * meaningful against the sort it was issued for — paging by "active" with a
 * cursor built from `created_at` skips and repeats rows — so the sort is
 * encoded into the cursor and checked on the way back in.
 */
const SORTS = {
  recent: { column: 't.created_at', direction: 'DESC' },
  active: { column: 'coalesce(t.last_post_at, t.created_at)', direction: 'DESC' },
  top: { column: 't.reaction_count', direction: 'DESC' },
  unanswered: { column: 't.created_at', direction: 'DESC' },
};

export const feed = async (
  { viewerId, spaceId, sort = 'active', kind, tag, authorId, following, cursor, limit = 20 },
  client = pool,
) => {
  const order = SORTS[sort] ?? SORTS.active;
  const params = [viewerId];
  const conditions = ['t.deleted_at IS NULL'];

  if (spaceId) {
    params.push(spaceId);
    conditions.push(`t.space_id = $${params.length}`);
  } else {
    // The cross-space feed only shows spaces the viewer is actually in.
    conditions.push('m.user_id IS NOT NULL');
  }

  if (kind) { params.push(kind); conditions.push(`t.kind = $${params.length}`); }
  if (authorId) { params.push(authorId); conditions.push(`t.author_id = $${params.length}`); }
  if (tag) { params.push(tag); conditions.push(`$${params.length} = ANY(t.tags)`); }
  if (following) conditions.push('f.user_id IS NOT NULL');
  if (sort === 'unanswered') conditions.push(`t.kind = 'question' AND t.resolved = false AND t.post_count = 0`);

  if (cursor) {
    const [sortName, value, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    if (sortName !== sort) {
      throw Object.assign(new Error('this cursor belongs to a different sort order'), {
        code: 'validation_failed',
      });
    }
    params.push(value, id);
    conditions.push(
      `(${order.column}, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }

  params.push(limit + 1);

  const { rows } = await client.query(
    `${SELECT} WHERE ${conditions.join(' AND ')}
      -- pinned first, but only within a single space: a pinned thread has no
      -- meaning in a feed that spans twelve of them
      ORDER BY ${spaceId ? 't.pinned DESC,' : ''} ${order.column} ${order.direction}, t.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);

  const cursorValue = last
    ? (sort === 'active' ? (last.last_post_at ?? last.created_at) : last.created_at)
    : null;

  return {
    items: page.map(rowToThread),
    hasMore,
    nextCursor: hasMore && last
      ? Buffer.from(`${sort}|${cursorValue.toISOString()}|${last.id}`).toString('base64url')
      : null,
  };
};

export const insert = async ({ spaceId, authorId, kind, title, body, tags = [], attachments = [] }, client = pool) => {
  const { rows } = await client.query(
    `INSERT INTO threads (space_id, author_id, kind, title, body, tags, attachments, last_post_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb, now())
     RETURNING id`,
    [spaceId, authorId, kind, title, body, tags, JSON.stringify(attachments)],
  );
  return findById(rows[0].id, authorId, client);
};

export const update = async (threadId, patch, viewerId = null, client = pool) => {
  const columns = {
    title: 'title', body: 'body', tags: 'tags', pinned: 'pinned',
    locked: 'locked', resolved: 'resolved', spaceId: 'space_id',
  };

  const sets = [];
  const params = [];

  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return findById(threadId, viewerId, client);

  // An edited title should say so; a pin should not.
  if (patch.title !== undefined || patch.body !== undefined) sets.push('edited_at = now()');

  params.push(threadId);
  await client.query(
    `UPDATE threads SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
    params,
  );
  return findById(threadId, viewerId, client);
};

export const softDelete = async (threadId, client = pool) => {
  const { rowCount } = await client.query(
    // The body is cleared, the row is not: moderation needs the audit trail
    // and the replies underneath it still need a parent.
    `UPDATE threads SET deleted_at = now(), body = '' WHERE id = $1 AND deleted_at IS NULL`,
    [threadId],
  );
  return rowCount > 0;
};

export const restore = async (threadId, client = pool) => {
  const { rowCount } = await client.query(
    `UPDATE threads SET deleted_at = NULL WHERE id = $1`,
    [threadId],
  );
  return rowCount > 0;
};

export const follow = async ({ threadId, userId, following }, client = pool) => {
  if (following) {
    await client.query(
      `INSERT INTO thread_follows (thread_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [threadId, userId],
    );
  } else {
    await client.query(`DELETE FROM thread_follows WHERE thread_id = $1 AND user_id = $2`, [threadId, userId]);
  }
  return following;
};

/** Everyone watching a thread: the author plus explicit followers. */
export const followers = async (threadId, excludeUserId, client = pool) => {
  const { rows } = await client.query(
    `SELECT DISTINCT user_id FROM (
       SELECT user_id FROM thread_follows WHERE thread_id = $1
       UNION
       SELECT author_id FROM threads WHERE id = $1 AND author_id IS NOT NULL
     ) watchers WHERE user_id <> $2`,
    [threadId, excludeUserId],
  );
  return rows.map((row) => row.user_id);
};

export default { findById, feed, insert, update, softDelete, restore, follow, followers, rowToThread };