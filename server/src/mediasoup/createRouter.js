// classroom-app/server/src/mediasoup/createRouter.js
/**
 * Router creation  (F1)  [UNCHANGED]
 *
 * Reference implementation, unchanged in behaviour from version 5. Keep your
 * existing file if it differs; nothing in version 6 depends on the details here
 * beyond the codec list coming from config/mediasoup.config.js.
 *
 * One router per room. The router is what lets the peers of a room exchange
 * media, and it lives inside one worker process — which is the reason a room
 * cannot be moved between workers or between nodes once it has started.
 */

import { routerOptions } from '../config/mediasoup.config.js';
import { logger } from '../observability/logger.js';
import { getWorker, trackRouter, untrackRouter } from './WorkerManager.js';

const log = logger.child({ component: 'router' });

/**
 * @param {string} roomId
 * @returns {Promise<{ router: import('mediasoup').types.Router, worker: import('mediasoup').types.Worker }>}
 */
export const createRouter = async (roomId) => {
  const slot = getWorker();
  const router = await slot.worker.createRouter(routerOptions);

  trackRouter(slot.worker, roomId);

  // A router closes when its worker dies, when the room ends, or when someone
  // closes it by hand. All three end up here.
  router.observer.once('close', () => {
    untrackRouter(slot.worker, roomId);
    log.debug({ roomId, routerId: router.id }, 'router closed');
  });

  log.info({ roomId, routerId: router.id, pid: slot.worker.pid }, 'router created');

  return { router, worker: slot.worker };
};

/**
 * Whether a router can serve a given client. A device that supports none of the
 * router's codecs cannot join, and finding that out here produces a clear
 * error rather than a session that connects and carries nothing.
 */
export const canConsume = (router, rtpCapabilities, producerId) =>
  router.canConsume({ producerId, rtpCapabilities });

export const closeRouter = (router) => {
  if (!router.closed) router.close();
};

export default createRouter;