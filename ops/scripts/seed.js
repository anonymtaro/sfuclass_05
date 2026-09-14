#!/usr/bin/env node
// ops/scripts/seed.js
// demo tenant for staging - never run against prod (guarded below).
// Usage: node ops/scripts/seed.js [--rooms=N] [--peers-per-room=M] [--cleanup]

const { Client } = require('pg');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

if (process.env.NODE_ENV === 'production') {
  console.error('seed.js refuses to run with NODE_ENV=production');
  process.exit(1);
}

const ROOMS = Number(args.rooms ?? 5);
const PEERS_PER_ROOM = Number(args['peers-per-room'] ?? 4);
const DEMO_TENANT_ID = 'demo-tenant';

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  if (args.cleanup) {
    console.log(`Removing demo tenant "${DEMO_TENANT_ID}" ...`);
    await client.query('DELETE FROM messages WHERE tenant_id = $1', [DEMO_TENANT_ID]);
    await client.query('DELETE FROM rooms WHERE tenant_id = $1', [DEMO_TENANT_ID]);
    await client.query('DELETE FROM courses WHERE tenant_id = $1', [DEMO_TENANT_ID]);
    await client.query('DELETE FROM users WHERE tenant_id = $1', [DEMO_TENANT_ID]);
    console.log('Demo tenant removed.');
    await client.end();
    return;
  }

  console.log(`Seeding demo tenant with ${ROOMS} rooms x ${PEERS_PER_ROOM} peers ...`);

  await client.query(
    `INSERT INTO users (id, tenant_id, display_name, role)
     VALUES ($1, $2, 'Demo Teacher', 'teacher')
     ON CONFLICT (id) DO NOTHING`,
    ['demo-teacher', DEMO_TENANT_ID],
  );

  const learnerIds = [];
  for (let p = 0; p < PEERS_PER_ROOM; p += 1) {
    const id = `demo-learner-${p}`;
    learnerIds.push(id);
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO users (id, tenant_id, display_name, role)
       VALUES ($1, $2, $3, 'learner')
       ON CONFLICT (id) DO NOTHING`,
      [id, DEMO_TENANT_ID, `Demo Learner ${p}`],
    );
  }

  const { rows: courseRows } = await client.query(
    `INSERT INTO courses (id, tenant_id, title)
     VALUES ($1, $2, 'Load Test Course')
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title
     RETURNING id`,
    ['demo-course', DEMO_TENANT_ID],
  );
  const courseId = courseRows[0].id;

  for (let r = 0; r < ROOMS; r += 1) {
    const roomId = `demo-room-${r}`;
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO rooms (id, tenant_id, course_id, mode)
       VALUES ($1, $2, $3, 'live')
       ON CONFLICT (id) DO NOTHING`,
      [roomId, DEMO_TENANT_ID, courseId],
    );
  }

  await client.end();
  console.log(`Seed complete: tenant=${DEMO_TENANT_ID}, course=${courseId}, learners=${learnerIds.length}, rooms=${ROOMS}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});