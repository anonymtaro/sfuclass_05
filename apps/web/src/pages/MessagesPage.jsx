/**
 * Messages — not implemented yet.
 *
 * main.jsx lazy-imports this route, so the file has to exist or navigating to
 * it throws a dynamic-import failure that looks like a build problem. Saying so
 * plainly is better than a blank screen.
 */
export default function MessagesPage() {
  return (
    <section className="page">
      <h1>Messages</h1>
      <p className="muted">This part of the product has not been built yet.</p>
    </section>
  );
}