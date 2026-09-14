// classroom-app/server/src/middleware/csrf.js
/**
 * CSRF  (F7)  [NEW]
 *
 * Scoped, not global — and the scoping is the design decision worth reading.
 *
 * The API authenticates with a bearer token in an Authorization header. A
 * browser does not attach that header to a cross-site request, so the API is
 * not CSRF-exposed and blanket CSRF protection would be ceremony: another
 * token to fetch, another way for a legitimate request to fail, no benefit.
 *
 * Exactly one surface is exposed: the routes that authenticate with the
 * httpOnly refresh cookie, because a browser *does* send cookies cross-site.
 * Those are listed in securityConfig.csrf.protectedPaths, and this middleware
 * guards them and nothing else.
 *
 * The mechanism is double-submit: a random value in a readable cookie, echoed
 * back in a header. An attacker's page can cause the cookie to be sent but
 * cannot read it to set the header, because it is on a different origin.
 *
 * Cookies are parsed here rather than through cookie-parser, so this file has
 * no ordering dependency on another middleware being mounted first.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from '@classroom/contracts';
import { csrfConfig } from '../config/security.config.js';

const TOKEN_BYTES = 32;

/** Minimal Cookie header parse. Values are URL-decoded, keys are not. */
const readCookie = (req, name) => {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
};

const serializeCookie = (name, value, options) => {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge) parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  if (options.domain && options.domain !== 'localhost') parts.push(`Domain=${options.domain}`);
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join('; ');
};

/** Constant-time comparison; a fast reject leaks the token a byte at a time. */
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

export const csrfProtection = () => {
  const { cookieName, headerName, protectedPaths, ignoredMethods, cookie } = csrfConfig;

  return (req, res, next) => {
    const existing = readCookie(req, cookieName);

    // Issue a token to any request that does not have one, not only to the
    // protected routes. Otherwise the first call a client makes to a protected
    // route always fails, and clients learn to retry blindly.
    if (!existing) {
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      res.append('Set-Cookie', serializeCookie(cookieName, token, cookie));
      req.csrfToken = token;
    } else {
      req.csrfToken = existing;
    }

    const isProtected = protectedPaths.some((path) => req.path.startsWith(path));
    if (!isProtected || ignoredMethods.includes(req.method)) return next();

    const supplied = req.get(headerName);

    if (!existing || !supplied || !equal(existing, supplied)) {
      req.log?.warn(
        { path: req.path, hasCookie: Boolean(existing), hasHeader: Boolean(supplied) },
        'csrf check failed',
      );
      return next(
        new ApiError('forbidden', {
          title: 'CSRF check failed',
          // Deliberately vague: naming which half was missing helps an
          // attacker more than it helps a developer, who has the docs.
          detail: 'This request could not be verified. Reload the page and try again.',
          traceId: req.traceId ?? '',
        }),
      );
    }

    next();
  };
};

export default csrfProtection;