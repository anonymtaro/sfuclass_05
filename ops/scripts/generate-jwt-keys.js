#!/usr/bin/env node
/**
 * ops/scripts/generate-jwt-keys.js
 *
 * Generates the RS256 key pair the access tokens are signed with, base64s each
 * PEM onto one line, and writes both into .env.
 *
 * RS256 rather than HS256 for one reason: the SFU has to *verify* tokens but
 * must never be able to *mint* them. An asymmetric pair gives the API the
 * private key and everyone else the public one. A shared secret would mean any
 * node that can check a token can also forge one.
 *
 * Development only. Staging and production keys live in Secrets Manager and are
 * rotated per ops/runbooks/rotate-secrets.md — never generated on a laptop.
 */

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_PATH = resolve(process.cwd(), '.env');
const force = process.argv.includes('--force');

if (!existsSync(ENV_PATH)) {
  console.error('No .env found. Run `cp .env.example .env` first.');
  process.exit(1);
}

const original = readFileSync(ENV_PATH, 'utf8');

const alreadySet = /^JWT_PRIVATE_KEY=.+$/m.test(original);
if (alreadySet && !force) {
  console.log('JWT keys are already set in .env. Pass --force to replace them.');
  console.log('Replacing them signs out every session immediately.');
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  // 2048 is the floor for RS256 and plenty for tokens that live 15 minutes.
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// base64 so a multi-line PEM survives a single-line environment variable —
// config/env.js decodes it back and rejects anything without a BEGIN block.
const encode = (pem) => Buffer.from(pem, 'utf8').toString('base64');

const replacements = {
  JWT_PRIVATE_KEY: encode(privateKey),
  JWT_PUBLIC_KEY: encode(publicKey),
};

let updated = original;
for (const [key, value] of Object.entries(replacements)) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  updated = pattern.test(updated) ? updated.replace(pattern, line) : `${updated.trimEnd()}\n${line}\n`;
}

writeFileSync(ENV_PATH, updated, 'utf8');

console.log('Wrote JWT_PRIVATE_KEY and JWT_PUBLIC_KEY into .env');
console.log('These are development keys. Never use them anywhere real.');