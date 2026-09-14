import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Placeholder dashboard.
 *
 * It exists for one reason right now: there has to be a way into a room before
 * the course builder and enrolment paths exist, or the classroom is unreachable
 * from the app. Replace the join box with the real lesson list once F3 lands.
 */
export default function DashboardPage() {
  const navigate = useNavigate();
  const [roomId, setRoomId] = useState('');

  return (
    <section className="page">
      <h1>Dashboard</h1>

      <div className="card">
        <h2>Join a lesson</h2>
        <p className="muted">
          Open this page in a second tab, signed in as a different person, to see two-way video.
        </p>
        <label htmlFor="roomId">Room id</label>
        <input
          id="roomId"
          value={roomId}
          onChange={(event) => setRoomId(event.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={!roomId.trim()}
          onClick={() => navigate(`/rooms/${roomId.trim()}`)}
        >
          Join
        </button>
      </div>
    </section>
  );
}