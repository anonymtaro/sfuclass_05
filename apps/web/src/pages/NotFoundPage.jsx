import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <section className="page">
      <h1>Page not found</h1>
      <p className="muted">That address does not lead anywhere.</p>
      <Link to="/">Back to the dashboard</Link>
    </section>
  );
}