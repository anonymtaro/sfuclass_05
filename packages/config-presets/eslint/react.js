/**
 * React preset  (F7)
 *
 * base + the hooks rules. Used by core-client (which ships hooks) and by both
 * app workspaces.
 *
 * `exhaustive-deps` is a warning rather than an error on purpose. It is right
 * most of the time and wrong in exactly the cases that matter — a dependency
 * array that would re-subscribe a socket on every render, for instance. Those
 * get an inline disable with a reason; making it an error would mean a wall of
 * disables that nobody reads.
 */

import reactHooks from 'eslint-plugin-react-hooks';
import base from './base.js';

export default [
  ...base,
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];