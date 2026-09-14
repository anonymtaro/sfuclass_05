// classroom-app/server/src/config/announcedIp.js
/**
 * Announced address resolution  (F1)  [UNCHANGED]
 *
 * Reproduced here for completeness; the logic is the same as in version 5.
 *
 * mediasoup binds to 0.0.0.0 but has to tell clients an address they can
 * actually reach. Inside ECS that is the host's public IP, which the container
 * cannot know without asking, so this queries the instance metadata service and
 * caches the answer for the life of the process.
 *
 * Getting this wrong is the single most common cause of "everyone joins and
 * nobody can hear anyone": ICE completes locally, media never arrives.
 */

import { env } from './env.js';

const IMDS_BASE = 'http://169.254.169.254';
const IMDS_TIMEOUT_MS = 1_000;

let cached = null;

/** IMDSv2 requires a token first; v1 is disabled on hardened AMIs. */
const fetchImdsToken = async () => {
  const response = await fetch(`${IMDS_BASE}/latest/api/token`, {
    method: 'PUT',
    headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '60' },
    signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`IMDS token request failed (${response.status})`);
  return response.text();
};

const fetchMetadata = async (path, token) => {
  const response = await fetch(`${IMDS_BASE}/latest/meta-data/${path}`, {
    headers: { 'x-aws-ec2-metadata-token': token },
    signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  return (await response.text()).trim() || null;
};

/**
 * Resolution order:
 *   1. ANNOUNCED_IP, when it is set to something other than the loopback
 *      default — an explicit setting always wins
 *   2. the instance's public IPv4
 *   3. its private IPv4, which is correct for a VPC-internal deployment
 *   4. 127.0.0.1, which is correct on a laptop and wrong everywhere else
 *
 * @returns {Promise<string>}
 */
export const resolveAnnouncedIp = async () => {
  if (cached) return cached;

  if (env.ANNOUNCED_IP && env.ANNOUNCED_IP !== '127.0.0.1') {
    cached = env.ANNOUNCED_IP;
    return cached;
  }

  try {
    const token = await fetchImdsToken();
    const publicIp = await fetchMetadata('public-ipv4', token);
    if (publicIp) {
      cached = publicIp;
      return cached;
    }
    const privateIp = await fetchMetadata('local-ipv4', token);
    if (privateIp) {
      cached = privateIp;
      return cached;
    }
  } catch {
    // Not on EC2, or metadata is blocked. Both are normal on a laptop.
  }

  cached = env.ANNOUNCED_IP || '127.0.0.1';
  return cached;
};

/** Synchronous accessor for code that runs after resolution. */
export const getAnnouncedIp = () => cached ?? env.ANNOUNCED_IP;

/** Tests only. */
export const resetAnnouncedIp = () => {
  cached = null;
};

export default resolveAnnouncedIp;