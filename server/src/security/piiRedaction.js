/**
 * piiRedaction — log scrubbing rules. (F7)
 *
 * Runs on every log line and on every audit payload, so it has two jobs that pull against
 * each other: remove anything that must not sit in CloudWatch for a year, and be cheap
 * enough that nobody is tempted to turn it off.
 *
 * The design that follows from that:
 *
 *  - Key-based redaction first. It is a string comparison against a Set, it catches the
 *    overwhelming majority of real leaks (`password`, `authorization`, `token`), and it
 *    does not depend on guessing what a value looks like.
 *  - Value-pattern redaction second, and only on strings, because that is where the cost
 *    is. Free text is where a token ends up when somebody logs a whole request body.
 *  - Bounded traversal. Depth, breadth and string length are all capped. A log call that
 *    accidentally passes a 40 MB object must produce a truncated line, not a stalled event
 *    loop — a redactor that can be turned into a denial of service by a log statement is
 *    worse than no redactor.
 *
 * What is deliberately NOT redacted: user ids, tenant ids, room ids, asset ids. Debugging
 * an incident without identifiers is impossible, and an opaque uuid is not personal data on
 * its own. Emails, names, tokens and anything payment-shaped are.
 */

const MAX_DEPTH = 6;
const MAX_KEYS = 200;
const MAX_STRING = 2000;

export const REDACTED = '[redacted]';

/** Case-insensitive. Matched against the key, not the path, so nesting cannot hide a field. */
const SENSITIVE_KEYS = new Set(
  [
    'password', 'passwd', 'pass', 'newpassword', 'oldpassword', 'passwordhash', 'password_hash',
    'token', 'accesstoken', 'access_token', 'refreshtoken', 'refresh_token', 'idtoken', 'id_token',
    'authorization', 'auth', 'cookie', 'cookies', 'setcookie', 'set-cookie',
    'secret', 'clientsecret', 'client_secret', 'apikey', 'api_key', 'privatekey', 'private_key',
    'jwt', 'sessionid', 'session_id', 'sid', 'csrf', 'csrftoken', 'xsrf',
    'creditcard', 'credit_card', 'cardnumber', 'card_number', 'cvv', 'cvc', 'pan', 'iban', 'bic',
    'ssn', 'taxid', 'tax_id', 'nationalid',
    'signature', 'stripesignature', 'stripe-signature',
    'otp', 'mfacode', 'totp', 'recoverycode',
    'pushtoken', 'push_token', 'devicetoken', 'device_token',
  ].map((key) => key.toLowerCase()),
);

/** Redacted to a shape rather than removed: `a***@example.com` is still debuggable. */
const PARTIAL_KEYS = new Set(['email', 'useremail', 'user_email', 'phone', 'phonenumber', 'phone_number']);

const PATTERNS = [
  // JWT — three base64url segments. The most common accidental leak by far.
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // Bearer/Basic in free text
  { name: 'bearer', re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  // Provider key shapes
  { name: 'stripe', re: /\b(?:sk|rk|pk|whsec)_(?:live_|test_)?[A-Za-z0-9]{16,}\b/g },
  { name: 'aws', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'pem', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // 13-19 digits with optional separators; verified with Luhn before redacting so order
  // numbers and ids are not mangled. Ends on a digit so a trailing space is not consumed.
  { name: 'card', re: /\b(?:\d[ -]?){12,18}\d\b/g, verify: luhn },
  { name: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, replace: maskEmail },
];

function luhn(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function maskEmail(value) {
  const at = value.indexOf('@');
  if (at < 1) return REDACTED;
  const local = value.slice(0, at);
  return `${local[0]}***${value.slice(at)}`;
}

function maskPhone(value) {
  const digits = String(value).replace(/\D/g, '');
  return digits.length < 4 ? REDACTED : `***${digits.slice(-4)}`;
}

/** Free-text scrubbing. Used on message bodies, error strings, anything unstructured. */
export function redactString(input) {
  if (typeof input !== 'string') return input;
  let value = input.length > MAX_STRING ? `${input.slice(0, MAX_STRING)}…[truncated]` : input;

  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    value = value.replace(pattern.re, (match) => {
      if (pattern.verify && !pattern.verify(match)) return match;
      return pattern.replace ? pattern.replace(match) : `[redacted:${pattern.name}]`;
    });
  }
  return value;
}

const isSensitive = (key) => SENSITIVE_KEYS.has(String(key).toLowerCase());
const isPartial = (key) => PARTIAL_KEYS.has(String(key).toLowerCase());

/**
 * Deep-redact a value. Returns a new structure; the input is never mutated, because the
 * caller is usually still using the object it just logged.
 */
export function redact(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;

  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Buffer.isBuffer(value)) return `[buffer:${value.length}]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: value.stack, code: value.code };
  }

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_KEYS).map((entry) => redact(entry, depth + 1, seen));
    if (value.length > MAX_KEYS) out.push(`[+${value.length - MAX_KEYS} more]`);
    return out;
  }

  const out = {};
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (count >= MAX_KEYS) {
      out['[truncated]'] = true;
      break;
    }
    count += 1;

    if (isSensitive(key)) {
      out[key] = REDACTED;
    } else if (isPartial(key) && typeof entry === 'string') {
      out[key] = entry.includes('@') ? maskEmail(entry) : maskPhone(entry);
    } else {
      out[key] = redact(entry, depth + 1, seen);
    }
  }
  return out;
}

/**
 * Paths for pino's own `redact` option. Faster than the walk above because pino compiles
 * them, so the common cases are handled before `redact()` is ever called.
 */
export const PINO_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["stripe-signature"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'token',
  '*.token',
  'refreshToken',
  '*.refreshToken',
  'accessToken',
  '*.accessToken',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'body.password',
  'body.token',
  'body.refreshToken',
];

/** For tests and the security review: is this key on the list? */
export const __rules = { SENSITIVE_KEYS, PARTIAL_KEYS, patterns: PATTERNS.map((p) => p.name) };