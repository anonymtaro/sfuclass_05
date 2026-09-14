import './chat.css';

/**
 * Typing state never touches PostgreSQL. TypingService.js publishes it over
 * Redis pub/sub with a short TTL, so a client that disappears mid-sentence stops
 * "typing" on its own — there is nothing to clean up and nothing to prune.
 *
 * Names are listed up to `max`, then counted. Reserving the row height even when
 * empty keeps the composer from jumping a line every time somebody starts typing.
 */
export default function TypingIndicator({ users = [], max = 2, className = '' }) {
  const names = users.map((u) => u.displayName);

  let label = '';
  if (names.length === 1) label = `${names[0]} is typing`;
  else if (names.length > 1 && names.length <= max) {
    label = `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are typing`;
  } else if (names.length > max) {
    label = `${names.slice(0, max).join(', ')} and ${names.length - max} more are typing`;
  }

  return (
    <p className={`ch ch-typing ${className}`} aria-live="polite">
      {label ? (
        <>
          <span className="ch-typing__dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {label}
        </>
      ) : (
        '\u00a0'
      )}
    </p>
  );
}