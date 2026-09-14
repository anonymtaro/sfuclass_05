import { useMemo, useState } from 'react';
import { useClassroom, usePresence } from '@classroom/core-client';
import { SignalingEvents } from '@classroom/contracts';
import UserProfileCard from '../Profile/UserProfileCard.jsx';
import './classroom.css';

const ROLE_ORDER = { host: 0, teacher: 0, assistant: 1, learner: 2 };

/**
 * The roster, and the room's main entry point into F6.
 *
 * Clicking a person opens UserProfileCard — the same card the community feed and
 * the course roster open — and that card carries the "Message" action, which
 * calls ConversationService.openOrCreateDirect(a, b). There is no separate
 * "new message" flow to keep in sync, so nothing about DMs lives in this file.
 *
 * Host actions emit moderation events; the decision is made in
 * server/src/classroom/ModerationControls.js and comes back as room state. A
 * learner who somehow renders these buttons still cannot mute anybody.
 */
export default function ParticipantList() {
  const { peers, self, room, emit } = useClassroom();
  const { statusOf } = usePresence();
  const [query, setQuery] = useState('');
  const [openUserId, setOpenUserId] = useState(null);

  const isHost = self.role === 'host' || self.role === 'teacher';

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = peers
      .filter((p) => !q || p.displayName.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) ||
          a.displayName.localeCompare(b.displayName),
      );

    return [
      { label: 'Hosts', people: visible.filter((p) => (ROLE_ORDER[p.role] ?? 3) <= 1) },
      { label: 'Learners', people: visible.filter((p) => (ROLE_ORDER[p.role] ?? 3) > 1) },
    ].filter((g) => g.people.length);
  }, [peers, query]);

  const muteAll = () => emit(SignalingEvents.moderation.muteAll, { roomId: room.id });
  const toggleLock = () =>
    emit(SignalingEvents.moderation.lockRoom, { roomId: room.id, locked: !room.locked });

  return (
    <section className="cr cr-panel cr-people" aria-label="Participants">
      <header className="cr-panel__head">
        <span>
          In this lesson <span className="cr-count">{peers.length}</span>
        </span>
        {isHost ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="cr-btn cr-btn--ghost" onClick={muteAll}>
              Mute everyone
            </button>
            <button
              type="button"
              className={`cr-btn cr-btn--ghost${room.locked ? ' cr-btn--active' : ''}`}
              onClick={toggleLock}
            >
              {room.locked ? 'Unlock room' : 'Lock room'}
            </button>
          </span>
        ) : null}
      </header>

      <input
        className="cr-people__search"
        type="search"
        value={query}
        placeholder="Find someone"
        aria-label="Find someone"
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="cr-panel__body">
        {groups.length === 0 ? (
          <p className="cr-empty">Nobody matches “{query}”.</p>
        ) : (
          groups.map((group) => (
            <div key={group.label}>
              <p className="cr-people__group">{group.label}</p>
              {group.people.map((peer) => {
                const presence = peer.id === self.id ? 'in-class' : statusOf(peer.userId);
                return (
                  <button
                    key={peer.id}
                    type="button"
                    className="cr-person"
                    onClick={() => setOpenUserId(peer.userId)}
                    aria-haspopup="dialog"
                  >
                    <img className="cr-person__avatar" src={peer.avatarUrl} alt="" />
                    <span className="cr-person__main">
                      <span className="cr-person__name">
                        {peer.displayName}
                        {peer.id === self.id ? ' (you)' : ''}
                      </span>
                      <span className="cr-person__meta">
                        <span className="cr-dot" data-presence={presence} aria-hidden="true" />{' '}
                        {peer.role}
                        {peer.handRaisedAt ? ' · hand up' : ''}
                      </span>
                    </span>
                    <span className="cr-person__icons" aria-hidden="true">
                      <span data-state={peer.producers.mic ? 'on' : 'off'} title="Microphone">
                        {peer.producers.mic ? '🎤' : '🔇'}
                      </span>
                      <span data-state={peer.producers.cam ? 'on' : 'off'} title="Camera">
                        {peer.producers.cam ? '🎥' : '⦸'}
                      </span>
                      {peer.producers.screen ? <span title="Sharing a screen">🖥</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>

      {openUserId ? (
        <UserProfileCard
          userId={openUserId}
          context={{ roomId: room.id, lessonId: room.lessonId }}
          onClose={() => setOpenUserId(null)}
          /* Host-only actions are rendered by the card when these are passed. */
          actions={
            isHost
              ? [
                  {
                    id: 'mute',
                    label: 'Mute',
                    run: (peerUserId) =>
                      emit(SignalingEvents.moderation.mutePeer, {
                        roomId: room.id,
                        userId: peerUserId,
                      }),
                  },
                  {
                    id: 'transfer-host',
                    label: 'Make host',
                    run: (peerUserId) =>
                      emit(SignalingEvents.moderation.transferHost, {
                        roomId: room.id,
                        userId: peerUserId,
                      }),
                  },
                  {
                    id: 'remove',
                    label: 'Remove from lesson',
                    tone: 'danger',
                    confirm: 'Remove this person from the lesson?',
                    run: (peerUserId) =>
                      emit(SignalingEvents.moderation.removePeer, {
                        roomId: room.id,
                        userId: peerUserId,
                      }),
                  },
                ]
              : []
          }
        />
      ) : null}
    </section>
  );
}