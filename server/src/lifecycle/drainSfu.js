// classroom-app/server/src/lifecycle/drainSfu.js
/**
 * SFU draining  (F1, F7)  [NEW]
 *
 * The SFU is the one stateful service in the platform. A running task holds
 * rooms, and a room holds people who are mid-sentence. Replacing a node the way
 * ECS replaces a stateless one — stop the task, start a new one — ends every
 * lesson on it.
 *
 * So the replacement is cooperative, and this module is the node's half of it:
 *
 *   1. deploy-sfu.yml writes an SSM parameter for this node:
 *        /classroom/{env}/sfu/{nodeId}/state = draining
 *   2. this watcher notices within one poll interval
 *   3. the node stops accepting new rooms — RoomRegistry no longer offers it,
 *      so route-resolve sends the next lesson somewhere else
 *   4. existing rooms keep running, untouched
 *   5. peers are told the node is draining, so a client that reconnects for
 *      any other reason goes elsewhere rather than back here
 *   6. when the last room ends, the node reports empty and the workflow stops
 *      the task
 *
 * Why SSM rather than an HTTP admin endpoint: the deploy role already has SSM
 * permission, no administrative route has to be exposed to the internet, and
 * the flag survives a task restart in the middle of a drain.
 *
 * The drain is patient but not infinite. SFU_DRAIN_TIMEOUT_SEC is the same
 * number the workflow uses, and when it expires the workflow stops the task
 * regardless — a deployment cannot wait for a room somebody left open over a
 * weekend.
 */

import { env } from '../config/env.js';

const POLL_INTERVAL_MS = 15_000;

let draining = false;
let drainStartedAt = null;
let watcher = null;
const listeners = new Set();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const isDraining = () => draining;

/**
 * Asked by RoomManager before it accepts a room, and by the route-resolve
 * route before it hands this node to a client.
 */
export const canAcceptRoom = () => !draining;

export const onDrain = (listener) => {
  listeners.add(listener);
  if (draining) listener();
  return () => listeners.delete(listener);
};

/**
 * Begins draining. Idempotent — the watcher calls it on every poll while the
 * flag is set, and an operator may call it by hand during an incident.
 */
export const beginDrain = async ({ logger = console, reason = 'ssm' } = {}) => {
  if (draining) return;
  draining = true;
  drainStartedAt = Date.now();

  logger.warn?.({ nodeId: env.SFU_NODE_ID, reason }, 'sfu draining: no new rooms');

  // Take this node out of the assignment pool first, before anything else can
  // be routed to it.
  try {
    const { markNodeDraining } = await import('../classroom/RoomRegistry.js');
    await markNodeDraining(env.SFU_NODE_ID);
  } catch (cause) {
    // Serious but not fatal: the registry entry expires on its own TTL, so
    // the node stops being offered within a minute either way.
    logger.error?.({ err: cause }, 'could not deregister node from the room registry');
  }

  // Tell the people already here. A client that has to reconnect for an
  // unrelated reason then resolves a different node instead of coming back.
  try {
    const { broadcastNodeDraining } = await import('../signaling/socketHandlers.js');
    broadcastNodeDraining({
      nodeId: env.SFU_NODE_ID,
      graceSec: env.SFU_DRAIN_TIMEOUT_SEC,
    });
  } catch (cause) {
    logger.error?.({ err: cause }, 'could not notify peers of the drain');
  }

  for (const listener of listeners) {
    try {
      listener();
    } catch (cause) {
      logger.warn?.({ err: cause }, 'drain listener threw');
    }
  }
};

// ---------------------------------------------------------------------------
// SSM watcher
// ---------------------------------------------------------------------------

const parameterName = (nodeId = env.SFU_NODE_ID, environment = process.env.DEPLOY_ENV ?? env.NODE_ENV) =>
  `/classroom/${environment}/sfu/${nodeId}/state`;

const readFlag = async (name, region) => {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const client = new SSMClient({ region });
  try {
    const response = await client.send(new GetParameterCommand({ Name: name }));
    return response.Parameter?.Value ?? 'active';
  } catch (cause) {
    // ParameterNotFound is the normal case: no drain has been requested.
    if (cause?.name === 'ParameterNotFound') return 'active';
    throw cause;
  }
};

/**
 * Starts polling. Called from the SFU bootstrap. A no-op outside AWS, so a
 * laptop does not need credentials to run a lesson locally.
 */
export const startDrainWatcher = ({
  logger = console,
  intervalMs = POLL_INTERVAL_MS,
  enabled = process.env.SECRETS_SOURCE === 'aws',
} = {}) => {
  if (!enabled) {
    logger.debug?.('drain watcher disabled outside aws');
    return () => {};
  }
  if (watcher) return () => clearInterval(watcher);

  const name = parameterName();
  const region = env.AWS_REGION;
  let consecutiveFailures = 0;

  logger.info?.({ parameter: name, intervalMs }, 'watching for a drain signal');

  watcher = setInterval(() => {
    void readFlag(name, region)
      .then((value) => {
        consecutiveFailures = 0;
        if (value === 'draining' && !draining) void beginDrain({ logger });
      })
      .catch((cause) => {
        consecutiveFailures += 1;
        // Noisy once, quiet after that: a broken watcher should be visible in
        // the logs without filling them.
        if (consecutiveFailures === 1 || consecutiveFailures % 20 === 0) {
          logger.error?.(
            { err: cause, consecutiveFailures },
            'could not read the drain flag',
          );
        }
      });
  }, intervalMs);

  watcher.unref();
  return () => {
    clearInterval(watcher);
    watcher = null;
  };
};

// ---------------------------------------------------------------------------
// Waiting for empty
// ---------------------------------------------------------------------------

/**
 * Resolves when the node holds no rooms, or when the timeout expires.
 *
 * Used as a shutdown step, so that a SIGTERM arriving before the drain has
 * finished still gives the lessons on this node a chance to end. The workflow
 * polls the ActiveRooms metric independently — both paths exist because a node
 * can be stopped by a deployment or by a scale-in event, and only one of those
 * writes an SSM parameter first.
 *
 * @returns {Promise<{ empty: boolean, waitedSec: number, remainingRooms: number }>}
 */
export const waitUntilEmpty = async ({
  timeoutSec = env.SFU_DRAIN_TIMEOUT_SEC,
  pollMs = 5_000,
  logger = console,
} = {}) => {
  const { getRoomCount } = await import('../classroom/RoomManager.js');
  const deadline = Date.now() + timeoutSec * 1_000;
  const startedAt = Date.now();
  let lastReported = -1;

  for (;;) {
    const rooms = getRoomCount();

    if (rooms === 0) {
      const waitedSec = Math.round((Date.now() - startedAt) / 1000);
      logger.info?.({ waitedSec }, 'sfu node is empty');
      return { empty: true, waitedSec, remainingRooms: 0 };
    }

    if (Date.now() >= deadline) {
      logger.warn?.(
        { rooms, timeoutSec },
        'drain timeout reached with rooms still live; they will be interrupted',
      );
      return {
        empty: false,
        waitedSec: Math.round((Date.now() - startedAt) / 1000),
        remainingRooms: rooms,
      };
    }

    // Log only when the number changes, otherwise a thirty-minute drain
    // produces four hundred identical lines.
    if (rooms !== lastReported) {
      logger.info?.(
        { rooms, remainingSec: Math.round((deadline - Date.now()) / 1000) },
        'waiting for rooms to end',
      );
      lastReported = rooms;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};

/**
 * The shutdown step for the SFU process. Drains first if nobody has already,
 * then waits.
 */
export const drainStep = ({ logger = console } = {}) => ({
  name: 'drain sfu',
  run: async () => {
    if (!draining) await beginDrain({ logger, reason: 'sigterm' });
    await waitUntilEmpty({ logger });
  },
});

export const drainStatus = () => ({
  nodeId: env.SFU_NODE_ID,
  draining,
  drainingForSec: drainStartedAt ? Math.round((Date.now() - drainStartedAt) / 1000) : 0,
  timeoutSec: env.SFU_DRAIN_TIMEOUT_SEC,
});

/** Tests only. */
export const resetDrainState = () => {
  draining = false;
  drainStartedAt = null;
  if (watcher) clearInterval(watcher);
  watcher = null;
  listeners.clear();
};

export default startDrainWatcher;