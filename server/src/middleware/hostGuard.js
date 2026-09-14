// classroom-app/server/src/middleware/hostGuard.js
/**
 * Host allowlist  (F7)  [NEW]
 *
 * The equivalent of Django's ALLOWED_HOSTS, and it exists for the same reason:
 * a request whose Host header this application does not recognise should not
 * reach a handler that will happily build an absolute URL out of it. That is
 * how password-reset links end up pointing at somebody else's domain.
 *
 * The load balancer already routes by host rule, so in a correct deployment
 * nothing here ever fires. It fires when the deployment is not correct — a
 * misconfigured listener rule, a direct hit on the task's IP, a stale DNS
 * record — and those are exactly the cases worth catching.
 *
 * Health checks are exempt. The ALB probes with the target's IP as the Host
 * header, and a task that fails its health check because of a host rule is a
 * task that never receives traffic and never explains why.
 */

import { ApiError } from '@classroom/contracts';
import { hostConfig } from '../config/security.config.js';

export const hostGuard = () => {
  const allowed = new Set(hostConfig.allowedHosts.map((host) => host.toLowerCase()));
  const exempt = hostConfig.exemptPaths;

  return (req, res, next) => {
    if (exempt.some((path) => req.path === path)) return next();

    const header = req.get('host');
    if (!header) {
      // HTTP/1.1 requires a Host header. Its absence is a malformed request,
      // not a routing mistake.
      return next(
        new ApiError('malformed_request', {
          detail: 'A Host header is required.',
          traceId: req.traceId ?? '',
        }),
      );
    }

    // Compare without the port: the allowlist names hosts, and the port
    // varies between the load balancer and a local run.
    const hostname = header.toLowerCase().split(':')[0];

    if (allowed.has(hostname)) return next();

    req.log?.warn({ host: header, path: req.path }, 'host not allowed');

    // 404 rather than 403 on purpose: a scanner hitting the task IP directly
    // learns nothing about what does exist here.
    next(
      new ApiError('not_found', {
        detail: 'No application is served at this host.',
        traceId: req.traceId ?? '',
      }),
    );
  };
};

export default hostGuard;