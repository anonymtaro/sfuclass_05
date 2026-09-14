import Constants from 'expo-constants';

type Extra = {
  apiUrl?: string;
  wsUrl?: string;
  cdnUrl?: string;
  variant?: string;
  release?: string;
};

const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

/**
 * The mobile counterpart of server/src/config/env.js: one place that reads the
 * environment, validates it, and fails loudly rather than letting an undefined
 * base URL turn into a request to `undefined/api/...` three screens later.
 */
function required(name: keyof Extra): string {
  const value = extra[name];
  if (!value) {
    throw new Error(
      `Missing ${name} in the Expo config. Set it in the EAS build profile (see eas.json).`,
    );
  }
  return value;
}

export const config = {
  apiUrl: required('apiUrl'),
  wsUrl: required('wsUrl'),
  cdnUrl: extra.cdnUrl ?? '',
  variant: extra.variant ?? 'production',
  release: extra.release ?? 'dev',
  appDomain: (extra.apiUrl ?? '').replace(/^https?:\/\/(api\.)?/, ''),
  isProduction: (extra.variant ?? 'production') === 'production',
};