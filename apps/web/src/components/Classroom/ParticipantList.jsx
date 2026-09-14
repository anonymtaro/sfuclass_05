import { useNavigate } from 'react-router-dom';

/**
 * Participant list  (F1, F6)
 *
 * Clicking a person opens their profile, and the profile carries the Message
 * action. That is the only way a direct message starts anywhere in the product
 * — participant list, community thread, public channel and course roster all
 * funnel through the same profile card, so there is no separate "new message"
 * flow to keep in sync.
 */
export default function ParticipantList({ peers, selfPeerId, canModerate, onHostAction }) {
  const navigate = useNavigate();

  const sorted = [...peers].sort((a, b) => {
    // Raised hands to the top, in the order they went up; hosts next.
    if (a.handRaised !== b.handRaised) return a.handRaised ? -1 : 1;
    const rank = { host: 0, cohost: 1, learner: 2 };
    if (rank[a.role] !== rank[b.role]) return rank[a.role] - rank[b.role];
    return a.user.displayName.localeCompare(b.user.displayName);
  });

  return (
    <aside className="participants">
      <h2 className="participants__title">In this room ({peers.length})</h2>

      <ul className="participants__list">
        {sorted.map((peer) => {
          const muted = !peer.producers.some(
            (producer) => producer.source === 'microphone' && !producer.paused,
          );
          const sharing = peer.producers.some((producer) => producer.source === 'screen');

          return (
            <li key={peer.peerId} className="participants__row">
              <button
                type="button"
                className="participants__person"
                onClick={() => navigate(`/profiles/${peer.user.userId}`)}
                title="Open profile"
              >
                {peer.user.avatarUrl ? (
                  <img src={peer.user.avatarUrl} alt="" className="participants__avatar" />
                ) : (
                  <span className="participants__avatar participants__avatar--initial">
                    {peer.user.displayName.charAt(0).toUpperCase()}
                  </span>
                )}

                <span className="participants__name">
                  {peer.user.displayName}
                  {peer.peerId === selfPeerId && ' (you)'}
                </span>

                {peer.role !== 'learner' && (
                  <span className="participants__role">{peer.role}</span>
                )}
              </button>

              <span className="participants__status" aria-hidden="true">
                {peer.handRaised && '✋'}
                {sharing && '🖥'}
                {muted && '🔇'}
              </span>

              {canModerate && peer.peerId !== selfPeerId && (
                <span className="participants__actions">
                  <button
                    type="button"
                    className="btn btn--tiny"
                    onClick={() => onHostAction({ targetPeerId: peer.peerId, action: 'mute' })}
                  >
                    Mute
                  </button>
                  <button
                    type="button"
                    className="btn btn--tiny btn--danger"
                    onClick={() => onHostAction({ targetPeerId: peer.peerId, action: 'remove' })}
                  >
                    Remove
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}