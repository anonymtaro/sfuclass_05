// classroom-app/server/src/classroom/interaction/Poll.js
/**
 * Polls  (F1)  [NEW]
 *
 * A question with options, live results, and one vote per person.
 *
 * Two decisions shape the code:
 *
 *   Votes are keyed by userId, not peerId. Someone who reconnects mid-poll gets
 *   a new peer id, and keying on that would let them vote twice — which in a
 *   graded quiz is a real problem and in a show-of-hands is just wrong.
 *
 *   Results can be hidden until the poll closes. A live tally changes how
 *   people vote, and for a comprehension check that defeats the purpose.
 */

import { randomUUID } from 'node:crypto';
import { recordInteraction } from '../AttendanceService.js';

/** roomId -> poll. One at a time; a second create closes the first. */
const active = new Map();

export const create = (room, actor, { question, options, anonymous = true, showResultsLive = false, multiple = false, durationSec = null }) => {
  if (!actor?.canModerate) {
    throw Object.assign(new Error('only a host may start a poll'), { code: 'not_room_host' });
  }
  if (!question?.trim() || !Array.isArray(options) || options.length < 2 || options.length > 10) {
    throw Object.assign(new Error('a poll needs a question and 2–10 options'), {
      code: 'validation_failed',
    });
  }

  // Starting a second poll ends the first rather than running both; two live
  // polls in one lesson is a UI nobody wants to build or use.
  if (active.has(room.id)) close(room, actor);

  const poll = {
    pollId: randomUUID(),
    roomId: room.id,
    question: question.trim(),
    options: options.map((label, index) => ({ optionId: `o${index + 1}`, label: String(label).slice(0, 200) })),
    anonymous,
    showResultsLive,
    multiple,
    createdBy: actor.user.userId,
    createdAt: new Date().toISOString(),
    endsAt: durationSec ? new Date(Date.now() + durationSec * 1000).toISOString() : null,
    closed: false,
    /** userId -> optionId[] */
    votes: new Map(),
    timer: null,
  };

  if (durationSec) {
    poll.timer = setTimeout(() => close(room, actor, 'timeout'), durationSec * 1000);
    poll.timer.unref();
  }

  active.set(room.id, poll);

  room.broadcast('classroom:poll.started', {
    pollId: poll.pollId,
    question: poll.question,
    options: poll.options,
    multiple: poll.multiple,
    anonymous: poll.anonymous,
    showResultsLive: poll.showResultsLive,
    endsAt: poll.endsAt,
  });

  return publicView(poll, { includeResults: false });
};

export const vote = (room, peer, { pollId, optionIds }) => {
  const poll = active.get(room.id);
  if (!poll || poll.pollId !== pollId) {
    return { ok: false, code: 'not_found', reason: 'no such poll' };
  }
  if (poll.closed) return { ok: false, code: 'conflict', reason: 'this poll has closed' };

  const chosen = (Array.isArray(optionIds) ? optionIds : [optionIds]).filter((id) =>
    poll.options.some((option) => option.optionId === id),
  );

  if (chosen.length === 0) return { ok: false, code: 'validation_failed' };
  if (!poll.multiple && chosen.length > 1) {
    return { ok: false, code: 'validation_failed', reason: 'only one option allowed' };
  }

  // Keyed by user, so changing your mind replaces your vote and reconnecting
  // does not give you a second one.
  const first = !poll.votes.has(peer.user.userId);
  poll.votes.set(peer.user.userId, chosen);

  if (first) recordInteraction(room.id, peer.user.userId, 'pollVotes');

  if (poll.showResultsLive) {
    room.broadcast('classroom:poll.results', tally(poll));
  } else {
    // Only the count moves, not the distribution — enough for the host to see
    // progress without revealing the answer.
    room.broadcast('classroom:poll.progress', { pollId: poll.pollId, voted: poll.votes.size });
  }

  return { ok: true, voted: chosen };
};

export const close = (room, actor, reason = 'closed') => {
  const poll = active.get(room.id);
  if (!poll || poll.closed) return null;
  if (reason !== 'timeout' && !actor?.canModerate) {
    throw Object.assign(new Error('only a host may close a poll'), { code: 'not_room_host' });
  }

  poll.closed = true;
  if (poll.timer) clearTimeout(poll.timer);
  active.delete(room.id);

  const results = tally(poll);
  room.broadcast('classroom:poll.closed', { ...results, reason });
  return results;
};

const tally = (poll) => {
  const counts = Object.fromEntries(poll.options.map((option) => [option.optionId, 0]));
  for (const chosen of poll.votes.values()) {
    for (const optionId of chosen) counts[optionId] += 1;
  }

  const total = poll.votes.size;

  return {
    pollId: poll.pollId,
    question: poll.question,
    voters: total,
    results: poll.options.map((option) => ({
      ...option,
      count: counts[option.optionId],
      percent: total === 0 ? 0 : Math.round((counts[option.optionId] / total) * 100),
    })),
    // Never included when the poll is anonymous, whatever the caller asks for.
    voters_detail: poll.anonymous ? null : [...poll.votes.keys()],
  };
};

const publicView = (poll, { includeResults }) => ({
  pollId: poll.pollId,
  question: poll.question,
  options: poll.options,
  closed: poll.closed,
  voters: poll.votes.size,
  ...(includeResults ? tally(poll) : {}),
});

export const current = (roomId) => {
  const poll = active.get(roomId);
  return poll ? publicView(poll, { includeResults: poll.showResultsLive }) : null;
};

export const clearRoom = (roomId) => {
  const poll = active.get(roomId);
  if (poll?.timer) clearTimeout(poll.timer);
  active.delete(roomId);
};

export const resetPolls = () => {
  for (const poll of active.values()) if (poll.timer) clearTimeout(poll.timer);
  active.clear();
};

export default { create, vote, close, current };