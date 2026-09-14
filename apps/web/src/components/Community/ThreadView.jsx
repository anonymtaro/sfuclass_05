import { useEffect, useState } from 'react';
import { useClassroomUser, useThread } from '@classroom/core-client';
import AttachmentTile from '../Chat/AttachmentTile.jsx';
import ReportBlockMenu from '../Chat/ReportBlockMenu.jsx';
import UserProfileCard from '../Profile/UserProfileCard.jsx';
import PostComposer from './PostComposer.jsx';
import PresenceAvatars from './PresenceAvatars.jsx';
import './community.css';

const REACTIONS = ['👍', '🎉', '🤔', '❤️', '👀'];
const timeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Post({ post, isOP, canModerate, me, onReact, onRemove, onMarkAnswer, onOpenProfile }) {
  return (
    <article className={`cm-post${post.isAnswer ? ' cm-post--answer' : ''}`}>
      <button
        type="button"
        className="cm-post__avatar"
        aria-label={`Open ${post.author.displayName}'s profile`}
        onClick={() => onOpenProfile(post.author.id)}
      >
        <img src={post.author.avatarUrl} alt="" loading="lazy" style={{ width: '100%', height: '100%', borderRadius: '50%' }} />
      </button>

      <div>
        <p className="cm-post__head">
          <button type="button" className="cm-post__author" onClick={() => onOpenProfile(post.author.id)}>
            {post.author.displayName}
          </button>

          {post.author.role && post.author.role !== 'learner' ? (
            <span className="cm-post__role">{post.author.role}</span>
          ) : null}

          {isOP ? <span className="cm-post__role">author</span> : null}
          {post.isAnswer ? <span className="cm-tag cm-tag--pinned">answer</span> : null}

          <time className="cm-post__time" dateTime={post.createdAt}>
            {timeFmt.format(new Date(post.createdAt))}
          </time>
          {post.editedAt ? <span className="cm-post__time">(edited)</span> : null}
        </p>

        {post.deletedAt ? (
          <p className="cm-post__body cm-muted">Removed by a moderator.</p>
        ) : (
          <p className="cm-post__body">{post.body}</p>
        )}

        {post.attachments?.map((a) => (
          <AttachmentTile key={a.id} attachment={a} />
        ))}

        {post.deletedAt ? null : (
          <div className="cm-reactions">
            {REACTIONS.map((emoji) => {
              const count = post.reactions?.[emoji]?.count ?? 0;
              const mine = Boolean(post.reactions?.[emoji]?.mine);
              if (!count && !mine) return null;
              return (
                <button
                  key={emoji}
                  type="button"
                  className="cm-reaction"
                  aria-pressed={mine}
                  onClick={() => onReact(post.id, emoji)}
                >
                  <span aria-hidden="true">{emoji}</span>
                  {count}
                </button>
              );
            })}

            {/* The add-reaction control stays separate so the counts above read
                as data rather than as a toolbar. */}
            <details style={{ display: 'inline-block' }}>
              <summary className="cm-reaction" style={{ listStyle: 'none' }}>
                + react
              </summary>
              <div className="cm-reactions" style={{ marginTop: 6 }}>
                {REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="cm-reaction"
                    onClick={() => onReact(post.id, emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </details>
          </div>
        )}
      </div>

      {post.deletedAt ? null : (
        <span className="cm-post__tools">
          {canModerate && !isOP ? (
            <button type="button" className="cm-btn cm-btn--ghost" onClick={() => onMarkAnswer(post.id)}>
              {post.isAnswer ? 'Unmark answer' : 'Mark as answer'}
            </button>
          ) : null}

          {post.author.id === me.id || canModerate ? (
            <button
              type="button"
              className="cm-btn cm-btn--ghost"
              onClick={() => {
                if (window.confirm('Remove this post?')) onRemove(post.id);
              }}
            >
              Remove
            </button>
          ) : null}

          <ReportBlockMenu
            targetUser={post.author}
            message={{ id: post.id, body: post.body }}
            canModerate={canModerate}
            compact
          />
        </span>
      )}
    </article>
  );
}

/**
 * A thread and everything under it.
 *
 * Posts are cursor-paginated the same way the feed is (FeedService), oldest
 * first, because a discussion is read forwards — unlike chat, where the newest
 * message is the one you want. That is why this view does not stick to the
 * bottom and has no unread jump button.
 *
 * Moderation is the same server path as chat: soft delete with an audit record,
 * report into one queue. A removed post leaves a tombstone rather than a gap, so
 * the replies underneath still make sense.
 */
export default function ThreadView({ threadId, onBack }) {
  const me = useClassroomUser();
  const {
    thread,
    posts,
    hasMore,
    loading,
    error,
    loadMore,
    createPost,
    react,
    removePost,
    markAnswer,
    togglePin,
    toggleLock,
    markRead,
  } = useThread(threadId);

  const [openUserId, setOpenUserId] = useState(null);

  useEffect(() => {
    if (thread && document.visibilityState === 'visible') markRead();
  }, [thread, markRead]);

  if (error) {
    return <p className="cm cm-empty">This thread could not be loaded.</p>;
  }

  if (!thread) {
    return <p className="cm cm-empty">Loading…</p>;
  }

  const canModerate = thread.myRole === 'moderator' || thread.myRole === 'owner';
  const locked = Boolean(thread.lockedAt);

  return (
    <section className="cm cm-thread" aria-label={thread.title}>
      <header className="cm-thread__head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {onBack ? (
            <button type="button" className="cm-btn cm-btn--ghost" onClick={onBack} aria-label="Back">
              ←
            </button>
          ) : null}
          <h1 className="cm-thread__title">{thread.title}</h1>
        </div>

        <div className="cm-thread__meta">
          <span>
            {thread.postCount} {thread.postCount === 1 ? 'reply' : 'replies'}
          </span>
          <span aria-hidden="true">·</span>
          <span>in {thread.spaceName}</span>

          {thread.pinnedAt ? <span className="cm-tag cm-tag--pinned">pinned</span> : null}
          {locked ? <span className="cm-tag cm-tag--locked">locked</span> : null}

          <span className="cm-composer__spacer" />

          <PresenceAvatars
            people={thread.participants ?? []}
            max={5}
            showLabel={false}
            context={{ threadId }}
          />

          {canModerate ? (
            <>
              <button type="button" className="cm-btn cm-btn--ghost" onClick={togglePin}>
                {thread.pinnedAt ? 'Unpin' : 'Pin'}
              </button>
              <button type="button" className="cm-btn cm-btn--ghost" onClick={toggleLock}>
                {locked ? 'Unlock' : 'Lock'}
              </button>
            </>
          ) : null}
        </div>
      </header>

      <div className="cm-thread__body">
        {posts.map((post, i) => (
          <Post
            key={post.id}
            post={post}
            isOP={i === 0}
            me={me}
            canModerate={canModerate}
            onReact={react}
            onRemove={removePost}
            onMarkAnswer={markAnswer}
            onOpenProfile={setOpenUserId}
          />
        ))}

        {hasMore ? (
          <button type="button" className="cm-btn" disabled={loading} onClick={loadMore}>
            {loading ? 'Loading…' : 'Show more replies'}
          </button>
        ) : null}
      </div>

      <div className="cm-thread__foot">
        <PostComposer
          mode="reply"
          spaceId={thread.spaceId}
          threadId={threadId}
          onSubmit={createPost}
          disabled={locked && !canModerate}
          disabledReason={
            locked ? 'This thread is locked. A moderator closed it to new replies.' : ''
          }
        />
      </div>

      {openUserId ? (
        <UserProfileCard
          userId={openUserId}
          context={{ spaceId: thread.spaceId, threadId }}
          onClose={() => setOpenUserId(null)}
        />
      ) : null}
    </section>
  );
}