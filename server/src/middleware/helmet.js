// classroom-app/server/src/middleware/helmet.js
/**
 * Security headers  (F7)  [NEW]
 *
 * Thin wrapper around helmet plus the two headers helmet does not set.
 *
 * The policy itself lives in config/security.config.js — this file only applies
 * it. Keeping the two apart means a reviewer reads one file to audit the
 * posture, and this one never grows into a second place where directives hide.
 *
 * Permissions-Policy is set by hand because camera, microphone and
 * display-capture are the product. Denying them would break every lesson;
 * leaving the header off entirely would let any embedded third-party frame ask
 * for them. Allowing them for `self` only is the narrow answer.
 */

import helmet from 'helmet';
import { helmetConfig, permissionsPolicy } from '../config/security.config.js';

export const helmetMiddleware = () => {
  const base = helmet(helmetConfig);

  return (req, res, next) => {
    base(req, res, (error) => {
      if (error) return next(error);

      res.setHeader('Permissions-Policy', permissionsPolicy);

      // Nothing this API returns should ever be stored by a shared cache.
      // Individual routes may relax this; none do so far.
      if (!res.getHeader('Cache-Control')) {
        res.setHeader('Cache-Control', 'no-store');
      }

      next();
    });
  };
};

export default helmetMiddleware;