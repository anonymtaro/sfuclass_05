// classroom-app/server/src/courses/models/Lesson.js
/**
 * Lesson row access  (F3)  [NEW]
 *
 * Five lesson types share one table, with the type-specific fields in a JSONB
 * `payload` column.
 *
 * Single-table-inheritance rather than five tables, because the operations that
 * matter are "every lesson in this module, in order" and "the next lesson for
 * this learner" — both of which become a five-way union with separate tables,
 * for no benefit. The type-specific shape is enforced by the zod union in
 * @classroom/contracts on the way in, which is a better place for it than a
 * check constraint nobody reads.
 *
 * The columns that are *not* in the payload are the ones something other than
 * the lesson itself needs to query: position, type, draft, and the room and
 * asset links.
 */

import { pool } from '../../db/pool.js';

export const TABLE = 'lessons';
export const POSITION_STEP = 100;

export const LESSON_TYPES = ['live', 'video', 'doc', 'quiz', 'task'];

export const rowToLesson = (row) => {
  const base = {
    lessonId: row.id,
    moduleId: row.module_id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    position: row.position,
    estimatedMinutes: row.estimated_minutes ?? 0,
    preview: row.preview,
    draft: row.draft,
  };

  const payload = row.payload ?? {};

  switch (row.type) {
    case 'live':
      return {
        ...base,
        roomId: row.room_id,
        scheduledStart: row.scheduled_start?.toISOString() ?? null,
        scheduledEnd: row.scheduled_end?.toISOString() ?? null,
        timeZone: payload.timeZone ?? null,
        recordingAssetId: row.recording_asset_id,
        recurring: payload.recurring ?? false,
      };
    case 'video':
      return {
        ...base,
        assetId: row.asset_id,
        asset: null, // filled in by the service when the lesson is served
        completionThresholdSec: payload.completionThresholdSec ?? null,
        allowDownload: payload.allowDownload ?? false,
      };
    case 'doc':
      return { ...base, body: payload.body ?? '', attachmentIds: payload.attachmentIds ?? [] };
    case 'quiz':
      return {
        ...base,
        questions: payload.questions ?? [],
        passPercent: payload.passPercent ?? 70,
        maxAttempts: payload.maxAttempts ?? null,
        shuffle: payload.shuffle ?? false,
      };
    case 'task':
      return { ...base, assignmentId: row.assignment_id, instructions: payload.instructions ?? '' };
    default:
      return base;
  }
};

/**
 * Strips the answers from a quiz. Called for every learner-facing read — a
 * quiz whose correct options are in the JSON payload is a quiz anybody can
 * pass with the network tab open.
 */
export const forLearner = (lesson) => {
  if (lesson.type !== 'quiz') return lesson;
  return {
    ...lesson,
    questions: lesson.questions.map(({ correctOptionIds, explanation, ...question }) => {
      void correctOptionIds;
      void explanation;
      return question;
    }),
  };
};

/** Splits a domain lesson into columns and payload. */
const toRow = (lesson) => {
  const { type } = lesson;
  const payload = {};

  if (type === 'live') {
    payload.timeZone = lesson.timeZone ?? null;
    payload.recurring = lesson.recurring ?? false;
  }
  if (type === 'video') {
    payload.completionThresholdSec = lesson.completionThresholdSec ?? null;
    payload.allowDownload = lesson.allowDownload ?? false;
  }
  if (type === 'doc') {
    payload.body = lesson.body ?? '';
    payload.attachmentIds = lesson.attachmentIds ?? [];
  }
  if (type === 'quiz') {
    payload.questions = lesson.questions ?? [];
    payload.passPercent = lesson.passPercent ?? 70;
    payload.maxAttempts = lesson.maxAttempts ?? null;
    payload.shuffle = lesson.shuffle ?? false;
  }
  if (type === 'task') {
    payload.instructions = lesson.instructions ?? '';
  }

  return {
    payload,
    assetId: type === 'video' ? (lesson.assetId ?? null) : null,
    assignmentId: type === 'task' ? (lesson.assignmentId ?? null) : null,
    scheduledStart: type === 'live' ? (lesson.scheduledStart ?? null) : null,
    scheduledEnd: type === 'live' ? (lesson.scheduledEnd ?? null) : null,
  };
};

export const listByModule = async (moduleId, client = pool) => {
  const { rows } = await client.query(
    `SELECT * FROM lessons WHERE module_id = $1 AND deleted_at IS NULL ORDER BY position ASC, created_at ASC`,
    [moduleId],
  );
  return rows.map(rowToLesson);
};

export const listByCourse = async (courseId, client = pool) => {
  const { rows } = await client.query(
    `SELECT l.* FROM lessons l
       JOIN modules m ON m.id = l.module_id
      WHERE m.course_id = $1 AND l.deleted_at IS NULL AND m.deleted_at IS NULL
      ORDER BY m.position ASC, l.position ASC`,
    [courseId],
  );
  return rows.map(rowToLesson);
};

export const findById = async (lessonId, client = pool) => {
  const { rows } = await client.query(
    `SELECT * FROM lessons WHERE id = $1 AND deleted_at IS NULL`,
    [lessonId],
  );
  return rows[0] ? rowToLesson(rows[0]) : null;
};

export const insert = async (lesson, client = pool) => {
  const { payload, assetId, assignmentId, scheduledStart, scheduledEnd } = toRow(lesson);

  const position =
    lesson.position ??
    (await client
      .query(
        `SELECT coalesce(max(position),0) + $2 AS next FROM lessons WHERE module_id = $1 AND deleted_at IS NULL`,
        [lesson.moduleId, POSITION_STEP],
      )
      .then(({ rows }) => rows[0].next));

  const { rows } = await client.query(
    `INSERT INTO lessons (module_id, type, title, summary, position, estimated_minutes,
                          preview, draft, payload, asset_id, assignment_id,
                          scheduled_start, scheduled_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [lesson.moduleId, lesson.type, lesson.title, lesson.summary ?? null, position,
     lesson.estimatedMinutes ?? 0, lesson.preview ?? false, lesson.draft ?? true,
     payload, assetId, assignmentId, scheduledStart, scheduledEnd],
  );

  return rowToLesson(rows[0]);
};

/**
 * The type never changes. Changing a video lesson into a quiz would orphan
 * every progress row against it, so the service creates a new lesson instead.
 */
export const update = async (lessonId, patch, client = pool) => {
  const existing = await findById(lessonId, client);
  if (!existing) return null;

  const merged = { ...existing, ...patch, type: existing.type };
  const { payload, assetId, assignmentId, scheduledStart, scheduledEnd } = toRow(merged);

  const { rows } = await client.query(
    `UPDATE lessons
        SET title = $2, summary = $3, estimated_minutes = $4, preview = $5, draft = $6,
            payload = $7, asset_id = $8, assignment_id = $9,
            scheduled_start = $10, scheduled_end = $11, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *`,
    [lessonId, merged.title, merged.summary ?? null, merged.estimatedMinutes ?? 0,
     merged.preview ?? false, merged.draft ?? true, payload, assetId, assignmentId,
     scheduledStart, scheduledEnd],
  );

  return rows[0] ? rowToLesson(rows[0]) : null;
};

/** A live lesson gains a room when its session opens; see LiveSessionLink. */
export const setRoom = async (lessonId, roomId, client = pool) => {
  await client.query(`UPDATE lessons SET room_id = $2, updated_at = now() WHERE id = $1`, [lessonId, roomId]);
};

export const setRecording = async (lessonId, assetId, client = pool) => {
  await client.query(
    `UPDATE lessons SET recording_asset_id = $2, updated_at = now() WHERE id = $1`,
    [lessonId, assetId],
  );
};

export const reorder = async (moduleId, orderedIds, targetModuleId = null, client = pool) => {
  const positions = orderedIds.map((_id, index) => (index + 1) * POSITION_STEP);
  const destination = targetModuleId ?? moduleId;

  const { rowCount } = await client.query(
    `UPDATE lessons AS l
        SET position = v.position, module_id = $3, updated_at = now()
       FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::int[]) AS position) AS v
      WHERE l.id = v.id`,
    [orderedIds, positions, destination],
  );
  return rowCount;
};

export const softDelete = async (lessonId, client = pool) => {
  const { rowCount } = await client.query(
    `UPDATE lessons SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [lessonId],
  );
  return rowCount > 0;
};

export default { listByModule, listByCourse, findById, insert, update, reorder, softDelete, forLearner, rowToLesson };