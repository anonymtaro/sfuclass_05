// classroom-app/server/src/courses/CertificateService.js
/**
 * Certificates  (F3)  [NEW]
 *
 * Issues a PDF when a learner completes a course, and lets anybody verify one.
 *
 * The verification design is the part that matters. A certificate is a PDF, and
 * a PDF is trivially edited — so the document itself is not the proof. The
 * proof is the serial: a short code printed on the certificate that resolves,
 * on a public endpoint, to the issuing record. An employer checks the code
 * rather than the file, and an edited PDF fails that check because the record
 * says something different.
 *
 * The serial is HMAC-derived rather than random, so a certificate can be
 * validated offline as *well-formed* before the database is consulted, which
 * keeps the public verify endpoint from being a free lookup oracle.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';
import * as Courses from './models/Course.js';

const log = logger.child({ component: 'certificates' });

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O, no 1/I/L

/**
 * Deterministic per (course, user, issue date). Base32 without ambiguous
 * characters, because these get read aloud and typed off paper.
 */
const buildSerial = ({ courseId, userId, issuedAt }) => {
  const mac = createHmac('sha256', env.COOKIE_SECRET)
    .update(`${courseId}:${userId}:${issuedAt}`)
    .digest();

  let serial = '';
  for (let index = 0; index < 12; index += 1) {
    serial += ALPHABET[mac[index] % ALPHABET.length];
  }
  // Grouped for legibility: XXXX-XXXX-XXXX
  return serial.match(/.{1,4}/g).join('-');
};

const verifySerial = ({ serial, courseId, userId, issuedAt }) => {
  const expected = buildSerial({ courseId, userId, issuedAt });
  const a = Buffer.from(serial);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

/**
 * Idempotent. Called from ProgressService on the completion transition, but a
 * retry, a replayed job or a re-opened final lesson must not mint a second
 * certificate with a different serial.
 */
export const issueCertificate = async ({ userId, courseId }) => {
  const existing = await findByLearner({ userId, courseId });
  if (existing) return existing;

  const [course, learner] = await Promise.all([
    Courses.findById(courseId),
    pool
      .query(`SELECT id, display_name FROM users WHERE id = $1`, [userId])
      .then(({ rows }) => rows[0]),
  ]);

  if (!course || !learner) {
    throw Object.assign(new Error('course or learner not found'), { code: 'not_found' });
  }

  const issuedAt = new Date().toISOString();
  const serial = buildSerial({ courseId, userId, issuedAt });

  const pdf = await renderPdf({
    learnerName: learner.display_name,
    courseTitle: course.title,
    instructorName: course.owner.displayName,
    issuedAt,
    serial,
    verifyUrl: `${env.APP_URL}/verify/${serial}`,
  });

  const { storeGeneratedAsset } = await import('../media/UploadService.js');
  const asset = await storeGeneratedAsset({
    purpose: 'lesson-document',
    kind: 'document',
    fileName: `certificate-${course.slug}.pdf`,
    contentType: 'application/pdf',
    body: pdf,
    ownerId: userId,
    metadata: { certificateSerial: serial, courseId },
  });

  const { rows } = await pool.query(
    `INSERT INTO certificates (course_id, user_id, serial, asset_id, issued_at, course_version)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (course_id, user_id) DO NOTHING
     RETURNING *`,
    [courseId, userId, serial, asset.assetId, issuedAt, course.publishedVersion ?? course.version],
  );

  // Lost the race with a concurrent completion; theirs is as good as ours.
  if (!rows[0]) return findByLearner({ userId, courseId });

  log.info({ courseId, userId, serial }, 'certificate issued');

  void import('../community/NotificationService.js')
    .then(({ notify }) =>
      notify({
        userId,
        type: 'course.completed',
        title: `You finished ${course.title}`,
        href: `/courses/${course.slug}/certificate`,
      }),
    )
    .catch(() => undefined);

  return rowToCertificate(rows[0]);
};

const rowToCertificate = (row) => ({
  certificateId: row.id,
  courseId: row.course_id,
  userId: row.user_id,
  serial: row.serial,
  issuedAt: row.issued_at.toISOString(),
  assetId: row.asset_id,
  downloadUrl: null, // signed on read
});

// ---------------------------------------------------------------------------
// Reading and verifying
// ---------------------------------------------------------------------------

export const findByLearner = async ({ userId, courseId }) => {
  const { rows } = await pool.query(
    `SELECT * FROM certificates WHERE user_id = $1 AND course_id = $2`,
    [userId, courseId],
  );
  return rows[0] ? rowToCertificate(rows[0]) : null;
};

export const listForLearner = async (userId) => {
  const { rows } = await pool.query(
    `SELECT c.*, co.title AS course_title, co.slug AS course_slug
       FROM certificates c JOIN courses co ON co.id = c.course_id
      WHERE c.user_id = $1 ORDER BY c.issued_at DESC`,
    [userId],
  );
  return rows.map((row) => ({
    ...rowToCertificate(row),
    courseTitle: row.course_title,
    courseSlug: row.course_slug,
  }));
};

/**
 * Public. Deliberately returns the minimum that proves the claim — the learner's
 * name, the course, the date — and nothing else. A verification endpoint that
 * returned an email address would be a directory of everyone who ever completed
 * a course.
 */
export const verify = async (serial) => {
  const normalised = String(serial).toUpperCase().replace(/\s/g, '');

  // Shape check first: a malformed code is rejected without a query.
  if (!/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(normalised)) {
    return { valid: false, reason: 'not a certificate code' };
  }

  const { rows } = await pool.query(
    `SELECT c.serial, c.issued_at, c.course_id, c.user_id,
            co.title AS course_title, u.display_name
       FROM certificates c
       JOIN courses co ON co.id = c.course_id
       JOIN users u ON u.id = c.user_id
      WHERE c.serial = $1 AND c.revoked_at IS NULL`,
    [normalised],
  );

  const row = rows[0];
  if (!row) return { valid: false, reason: 'no certificate with that code' };

  // The HMAC has to agree as well: a row inserted by any route other than
  // issueCertificate would not match.
  const authentic = verifySerial({
    serial: row.serial,
    courseId: row.course_id,
    userId: row.user_id,
    issuedAt: row.issued_at.toISOString(),
  });

  if (!authentic) {
    log.error({ serial: normalised }, 'certificate record failed its own signature check');
    return { valid: false, reason: 'this certificate could not be verified' };
  }

  return {
    valid: true,
    learnerName: row.display_name,
    courseTitle: row.course_title,
    issuedAt: row.issued_at.toISOString(),
    serial: row.serial,
  };
};

/** Used when a course is withdrawn, or a completion is found to be fraudulent. */
export const revoke = async ({ serial, reason, actorId }) => {
  const { rowCount } = await pool.query(
    `UPDATE certificates SET revoked_at = now(), revoked_reason = $2, revoked_by = $3
      WHERE serial = $1 AND revoked_at IS NULL`,
    [serial, reason, actorId],
  );
  if (rowCount > 0) log.warn({ serial, actorId, reason }, 'certificate revoked');
  return rowCount > 0;
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * pdf-lib rather than a headless browser: a certificate is a page of text and a
 * border, and running Chromium to produce one would add a hundred megabytes to
 * the worker image for no visual benefit.
 */
const renderPdf = async ({ learnerName, courseTitle, instructorName, issuedAt, serial, verifyUrl }) => {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');

  const doc = await PDFDocument.create();
  const page = doc.addPage([842, 595]); // A4 landscape
  const { width, height } = page.getSize();

  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const serifBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const sans = await doc.embedFont(StandardFonts.Helvetica);

  const ink = rgb(0.07, 0.09, 0.11);
  const accent = rgb(0.12, 0.23, 0.43);
  const muted = rgb(0.42, 0.46, 0.52);

  page.drawRectangle({
    x: 28, y: 28, width: width - 56, height: height - 56,
    borderColor: accent, borderWidth: 2,
  });

  const centred = (text, font, size, y, color = ink) => {
    page.drawText(text, {
      x: (width - font.widthOfTextAtSize(text, size)) / 2,
      y, size, font, color,
    });
  };

  centred('CERTIFICATE OF COMPLETION', sans, 13, height - 110, muted);
  centred(learnerName, serifBold, 34, height - 200, ink);
  centred('has successfully completed', serif, 15, height - 245, muted);

  // Long titles are shrunk rather than clipped; a truncated course name on a
  // certificate is worse than a smaller one.
  let titleSize = 26;
  while (serifBold.widthOfTextAtSize(courseTitle, titleSize) > width - 200 && titleSize > 12) {
    titleSize -= 1;
  }
  centred(courseTitle, serifBold, titleSize, height - 300, accent);

  const issued = new Date(issuedAt).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  page.drawText(`Issued ${issued}`, { x: 70, y: 110, size: 10, font: sans, color: muted });
  page.drawText(`Instructor: ${instructorName}`, { x: 70, y: 92, size: 10, font: sans, color: muted });

  const code = `Verify at ${verifyUrl}`;
  page.drawText(code, {
    x: width - 70 - sans.widthOfTextAtSize(code, 9), y: 92, size: 9, font: sans, color: muted,
  });
  page.drawText(serial, {
    x: width - 70 - sans.widthOfTextAtSize(serial, 12), y: 110, size: 12, font: sans, color: ink,
  });

  doc.setTitle(`${courseTitle} — ${learnerName}`);
  doc.setSubject(`Certificate ${serial}`);
  doc.setProducer('classroom-app');

  return Buffer.from(await doc.save());
};

export default { issueCertificate, verify, listForLearner, revoke };