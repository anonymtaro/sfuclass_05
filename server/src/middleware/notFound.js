// classroom-app/server/src/middleware/notFound.js
/**
 * Unmatched routes  (F7)  [NEW]
 *
 * Mounted after every router and before the error handler, so a request for a
 * path nobody claimed gets the same error shape as everything else instead of
 * Express's HTML default page.
 *
 * The HTML matters more than it sounds: a mobile client parsing JSON receives
 * `<!DOCTYPE html>`, fails at the parse rather than at the status code, and
 * reports something misleading. One shape everywhere is the point.
 *
 * The response says nothing about what does exist. Someone probing for
 * `/admin` or `/.env` learns only that this path is not it.
 */

import { ApiError } from '@classroom/contracts';

export const notFound = () => (req, res, next) => {
  // Logged at debug, not warn: a 404 is usually a scanner, and a scanner
  // should not be able to fill the log budget.
  req.log?.debug({ method: req.method, path: req.path }, 'no route matched');

  next(
    new ApiError('not_found', {
      detail: `No route matches ${req.method} ${req.path}.`,
      traceId: req.traceId ?? '',
    }),
  );
};

export default notFound;