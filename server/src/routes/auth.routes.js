/**
 * auth.routes — login · refresh · logout · devices (F5)
 *
 * The split that matters here: the API is bearer-token based, but the refresh token lives
 * in an httpOnly, SameSite=Strict cookie. That is why CSRF protection applies to exactly
 * one route — `/auth/refresh` — and nowhere else. A bearer endpoint cannot be CSRF'd; a
 * cookie endpoint can.
 *
 *  - Access tokens are short-lived RS256, so the SFU can verify them with the public key
 *    without ever holding the signing key.
 *  - Refresh tokens rotate on every use and are bound to a device session. Reuse of an
 *    already-rotated token is treated as theft: the whole session family is revoked.
 *  - Logout revokes server-side (SessionStore), because "the client deleted the token" is
 *    not a security property.
 *
 * Rate limits here are stricter than the global ones — credential stuffing is the whole
 * point of this file's existence.
 */

import { Router } from 'express';
import { z } from 'zod';

import * as AuthService from '../identity/AuthService.js';
import * as DeviceRegistry from '../identity/DeviceRegistry.js';
import { env } from '../config/env.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { csrfProtection } from '../middleware/csrf.js';
import { route, validate, requireAuth, noStore, unauthorised } from './_helpers.js';

const router = Router();

const REFRESH_COOKIE = 'cp_refresh';

const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/auth',
  maxAge: env.REFRESH_TTL * 1000,
  signed: true,
});

const deviceSchema = z.object({
  deviceId: z.string().max(128).optional(),
  platform: z.enum(['web', 'ios', 'android']).default('web'),
  model: z.string().max(128).optional(),
  appVersion: z.string().max(32).optional(),
});

function issue(res, tokens) {
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, refreshCookieOptions());
  noStore(res);
  return {
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn,
    tokenType: 'Bearer',
    user: tokens.user,
    // The refresh token is never in the body on web. Mobile asks for it explicitly below.
  };
}

/* ------------------------------------------------------------------ *
 * Credentials
 * ------------------------------------------------------------------ */

router.post(
  '/auth/login',
  rateLimit({ key: 'auth:login', points: 10, durationSec: 300, by: ['ip', 'body.email'] }),
  validate({
    body: z.object({
      email: z.string().email(),
      password: z.string().min(1).max(512),
      device: deviceSchema.optional(),
      // Mobile cannot use a cookie; it gets the refresh token in the body instead.
      wantsRefreshToken: z.boolean().default(false),
    }),
  }),
  route(async (req, res) => {
    const tokens = await AuthService.login({
      email: req.body.email,
      password: req.body.password,
      device: req.body.device ?? { platform: 'web' },
      ip: req.ip,
      userAgent: req.get('user-agent') ?? null,
    });

    const body = issue(res, tokens);
    if (req.body.wantsRefreshToken) body.refreshToken = tokens.refreshToken;
    return body;
  }),
);

/**
 * Cookie route → double-submit CSRF token required. Mobile sends the refresh token in the
 * body and skips the cookie path entirely.
 */
router.post(
  '/auth/refresh',
  rateLimit({ key: 'auth:refresh', points: 60, durationSec: 300, by: ['ip'] }),
  csrfProtection,
  validate({ body: z.object({ refreshToken: z.string().min(1).optional() }).default({}) }),
  route(async (req, res) => {
    const presented = req.body.refreshToken ?? req.signedCookies?.[REFRESH_COOKIE];
    if (!presented) throw unauthorised('No refresh token presented');

    const tokens = await AuthService.rotateRefreshToken({
      refreshToken: presented,
      ip: req.ip,
      userAgent: req.get('user-agent') ?? null,
    });

    const body = issue(res, tokens);
    if (req.body.refreshToken) body.refreshToken = tokens.refreshToken;
    return body;
  }),
);

router.post(
  '/auth/logout',
  csrfProtection,
  route(async (req, res) => {
    const presented = req.body?.refreshToken ?? req.signedCookies?.[REFRESH_COOKIE];
    if (presented) await AuthService.revokeSession({ refreshToken: presented });
    res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
    noStore(res);
    return { loggedOut: true };
  }),
);

/** Every device, everywhere — the "I lost my phone" button. */
router.post(
  '/auth/logout-all',
  requireAuth,
  route(async (req, res) => {
    const revoked = await AuthService.revokeAllSessions(req.user.id);
    res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
    noStore(res);
    return { revoked };
  }),
);

/* ------------------------------------------------------------------ *
 * Device sessions and push tokens
 * ------------------------------------------------------------------ */

router.get(
  '/auth/devices',
  requireAuth,
  route(async (req, res) => {
    noStore(res);
    return { devices: await DeviceRegistry.listForUser(req.user.id) };
  }),
);

router.delete(
  '/auth/devices/:deviceId',
  requireAuth,
  validate({ params: z.object({ deviceId: z.string().max(128) }) }),
  route(async (req) => {
    await AuthService.revokeDeviceSession(req.user.id, req.params.deviceId);
    return null;
  }),
);

router.put(
  '/auth/devices/push-token',
  requireAuth,
  validate({
    body: z.object({
      deviceId: z.string().max(128),
      platform: z.enum(['ios', 'android', 'web']),
      token: z.string().min(1).max(512),
    }),
  }),
  route(async (req) => {
    const registration = await DeviceRegistry.upsertPushToken({ userId: req.user.id, ...req.body });
    return { registered: true, endpointArn: registration.endpointArn ?? null };
  }),
);

/** Who am I — cheap enough to call on app boot, and it proves the token is still live. */
router.get(
  '/auth/me',
  requireAuth,
  route(async (req, res) => {
    noStore(res);
    return AuthService.describeSession({ userId: req.user.id, sessionId: req.user.sessionId });
  }),
);

export default router;