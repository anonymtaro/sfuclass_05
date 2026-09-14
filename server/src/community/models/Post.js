// classroom-app/server/src/community/models/Post.js
/**
 * Post row access  (F2)  [NEW]
 *
 * Replies, one level deep. `reply_to_post_id` records who someone answered, but
 * a reply to a reply still belongs to the thread rather than nesting under its
 * parent — deeper nesting is unreadable on a phone and turns the thread query
 * into a recursive CTE for no gain.
 *
 * Inserting a post updates the thread's counters in the same transaction. That
 * is the only way `post_count` and `last_post_at` can be trusted, and the feed
 * depends on them being right.
 */

import { pool } from '../../db/pool.js';

export const TABLE = 'posts';

export const rowToPost = (row) => ({
  postId: row.id,
  threadId: row.thread_id,
  author: row.author_id
    ? { userId: row.author_id, displayName: row.author_name ?? '', avatarUrl: row.author_avatar ?? null }
    : null,
  body: row.body,
  attachments: row.attachments ?? [],
  mentions: row.mentions ?? [],
  reactions: row.reactions ?? [],
  replyToPostId: row.reply_to_post_id,
  acceptedAnswer: row.accepted_answer,
  editedAt: row.edited_at?.toISOString() ?? null,
  deletedAt: row.deleted_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
});

const SELECT = `
  SELECT p.*, u.display_name AS author_name, u.avatar_url AS author_avatar
    FROM posts p LEFT JOIN users u ON u.id = p.author_id
`;

export const listByThread = async ({ threadId, cursor, limit = 25 }, client = pool) => {
  const params = [threadId];
  // Oldest first: a discussion is read in the order it happened.
  let where = 'p.thread_id = $1';

  if (cursor) {
    const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    params.push(at, id);
    where += ` AND (p.created_at, p.id) > ($2::timestamptz, $3::uuid)`;
  }
  params.push(limit + 1);

  const { rows } = await client.query(
    `${SELECT} WHERE ${where}
      -- an accepted answer floats to the top of a question, wherever it was posted
      ORDER BY p.accepted_answer DESC, p.created_at ASC, p.id ASC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    items: page.map(rowToPost),
    hasMore,
    nextCursor: hasMore && page.at(-1)
      ? Buffer.from(`${page.at(-1).created_at.toISOString()}|${page.at(-1).id}`).toString('base64url')
      : null,
  };
};

export const findById = async (postId, client = pool) => {
  const { rows } = await client.query(`${SELECT} WHERE p.id = $1`, [postId]);
  return rows[0] ? rowToPost(rows[0]) : null;
};

/**
 * Insert plus counter maintenance, in one transaction.
 *
 * `idempotencyKey` is the client's post id. A reply lost to a dropped
 * connection and retried must update the original rather than appear twice —
 * the duplicated reply is the failure people complain about in a forum.
 */
export const insert = async (
  { threadId, authorId, body, replyToPostId = null, mentions = [], attachments = [], idempotencyKey = null },
  client = pool,
) => {
  const owned = client === pool;
  const connection = owned ? await pool.connect() : client;

  try {
    if (owned) await connection.query('BEGIN');

    const { rows } = await connection.query(
      `INSERT INTO posts (thread_id, author_id, body, reply_to_post_id, mentions, attachments, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET body = EXCLUDED.body, edited_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [threadId, authorId, body, replyToPostId, mentions, JSON.stringify(attachments), idempotencyKey],
    );

    // xmax = 0 means a genuine insert rather than the conflict path, so a
    // retry does not bump the thread's counters a second time.
    if (rows[0].inserted) {
      await connection.query(
        `UPDATE threads
            SET post_count = post_count + 1,
                last_post_at = now(),
                last_poster_id = $2,
                participant_count = (
                  SELECT count(DISTINCT author_id) FROM posts
                   WHERE thread_id = $1 AND deleted_at IS NULL
                ) + 1,
                updated_at = now()
          WHERE id = $1`,
        [threadId, authorId],
      );
    }

    if (owned) await connection.query('COMMIT');
    return findById(rows[0].id, connection === pool ? pool : connection);
  } catch (cause) {
    if (owned) await connection.query('ROLLBACK');
    throw cause;
  } finally {
    if (owned) connection.release();
  }
};

export const update = async (postId, { body }, client = pool) => {
  const { rows } = await client.query(
    `UPDATE posts SET body = $2, edited_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [postId, body],
  );
  return rows[0] ? findById(postId, client) : null;
};

/**
 * Soft delete, and the counter comes back down. The row stays: a reply that
 * quoted it still needs its parent to exist, and moderation needs the record.
 */
export const softDelete = async (postId, client = pool) => {
  const owned = client === pool;
  const connection = owned ? await pool.connect() : client;

  try {
    if (owned) await connection.query('BEGIN');

    const { rows } = await connection.query(
      `UPDATE posts SET deleted_at = now(), body = ''
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING thread_id`,
      [postId],
    );

    if (rows[0]) {
      await connection.query(
        `UPDATE threads SET post_count = GREATEST(0, post_count - 1) WHERE id = $1`,
        [rows[0].thread_id],
      );
    }

    if (owned) await connection.query('COMMIT');
    return Boolean(rows[0]);
  } catch (cause) {
    if (owned) await connection.query('ROLLBACK');
    throw cause;
  } finally {
    if (owned) connection.release();
  }
};

/** One accepted answer per question; accepting a second replaces the first. */
export const acceptAnswer = async ({ threadId, postId }, client = pool) => {
  const owned = client === pool;
  const connection = owned ? await pool.connect() : client;

  try {
    if (owned) await connection.query('BEGIN');
    await connection.query(`UPDATE posts SET accepted_answer = false WHERE thread_id = $1`, [threadId]);
    await connection.query(`UPDATE posts SET accepted_answer = true WHERE id = $1 AND thread_id = $2`, [postId, threadId]);
    await connection.query(`UPDATE threads SET resolved = true, updated_at = now() WHERE id = $1`, [threadId]);
    if (owned) await connection.query('COMMIT');
    return true;
  } catch (cause) {
    if (owned) await connection.query('ROLLBACK');
    throw cause;
  } finally {
    if (owned) connection.release();
  }
};

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/**
 * One table for thread and post reactions, discriminated by target type. The
 * aggregate is stored back on the row so the feed does not have to group a
 * reactions table on every read.
 */
export const react = async ({ targetType, targetId, userId, emoji, action }, client = pool) => {
  if (action === 'add') {
    await client.query(
      `INSERT INTO reactions (target_type, target_id, user_id, emoji)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [targetType, targetId, userId, emoji],
    );
  } else {
    await client.query(
      `DELETE FROM reactions WHERE target_type = $1 AND target_id = $2 AND user_id = $3 AND emoji = $4`,
      [targetType, targetId, userId, emoji],
    );
  }

  const table = targetType === 'thread' ? 'threads' : 'posts';
  const { rows } = await client.query(
    `WITH tally AS (
       SELECT emoji, count(*)::int AS count
         FROM reactions WHERE target_type = $1 AND target_id = $2
        GROUP BY emoji ORDER BY count DESC LIMIT 20
     )
     UPDATE ${table} SET reactions = coalesce((SELECT jsonb_agg(tally) FROM tally), '[]'::jsonb),
                         reaction_count = (SELECT coalesce(sum(count),0) FROM tally)
      WHERE id = $2
      RETURNING reactions`,
    [targetType, targetId],
  );

  return rows[0]?.reactions ?? [];
};

export default { listByThread, findById, insert, update, softDelete, acceptAnswer, react, rowToPost };