/**
 * HTTP transport.
 *
 * One client, three runtimes: the browser, React Native and Node (tests, SSR).
 * It therefore depends on `fetch` and nothing else — no axios, no XHR, no
 * platform globals beyond what all three have.
 *
 * What it handles so that no caller has to:
 *
 *   auth        injects the access token, refreshes once on 401 and replays the
 *               request; concurrent 401s share a single refresh
 *   retries     network failures and retryable ApiErrors, with exponential
 *               backoff and jitter — but never for a non-idempotent request
 *               that carries no idempotency key
 *   tracing     a fresh request id per attempt, a stable trace id per logical
 *               request, both echoed in the server logs
 *   errors      every failure arrives as an ApiError, whatever went wrong
 *   validation  an optional zod schema parses the response, so a route that
 *               drifts from the contract fails here rather than three layers up
 *
 * Deliberately not handled here: offline queueing and optimistic state. Those
 * live in offline/syncQueue.ts and the state/ hooks, because they need to know
 * what a mutation means, and this file does not.
 */

import type { z } from 'zod';
import {
  ApiError,
  CONTRACT_VERSION,
  HEADERS,
  isRetryable,
  type ErrorCode,
} from '@classroom/contracts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Methods that may be replayed safely without an idempotency key. */
const IDEMPOTENT_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>(['GET', 'PUT', 'DELETE']);

export interface AuthProvider {
  /** Current access token, or null when signed out. */
  getAccessToken(): string | null | Promise<string | null>;
  /**
   * Exchanges the refresh credential for a new access token. Called at most
   * once per 401 burst; the client serialises concurrent callers onto one
   * promise. Returns null when the session is truly gone.
   */
  refresh(): Promise<string | null>;
  /** The refresh failed. Clients route to the sign-in screen from here. */
  onSessionExpired?(): void;
  /** Double-submit token for the cookie-based refresh route. */
  getCsrfToken?(): string | null;
}

export interface RetryPolicy {
  /** Attempts in total, including the first. 1 disables retrying. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface HttpClientOptions {
  /** e.g. 'https://api.classroom.app'. A trailing slash is tolerated. */
  baseUrl: string;
  auth?: AuthProvider;
  /** Injected so tests and React Native can substitute their own. */
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout. A retry gets a fresh budget. */
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  /** Sent on every request; the server rejects an unsupported major. */
  contractVersion?: string;
  /** Web sends the refresh cookie; mobile keeps tokens in secure storage. */
  credentials?: RequestCredentials;
  defaultHeaders?: Record<string, string>;
  /** Observability hooks. Wired to the logger in the app layer, not here. */
  onRequest?(info: RequestInfoEvent): void;
  onResponse?(info: ResponseInfoEvent): void;
  /** The API no longer speaks this build's contract version. */
  onContractMismatch?(serverVersion: string | null): void;
}

export interface RequestOptions<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  method?: HttpMethod;
  /** Serialised as JSON unless it is FormData or a string. */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  /** Parsed and type-narrowed on success. Omit to get the raw JSON. */
  schema?: TSchema;
  /**
   * Makes a mutation safely retryable. The same key is reused across attempts,
   * which is the whole point — a retry must be recognisable as the same call.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  /** Skips the token and the refresh dance. Used by the auth routes. */
  anonymous?: boolean;
}

export interface RequestInfoEvent {
  method: HttpMethod;
  path: string;
  requestId: string;
  traceId: string;
  attempt: number;
}

export interface ResponseInfoEvent extends RequestInfoEvent {
  status: number;
  durationMs: number;
  error?: ErrorCode;
}

type BodylessOptions<TSchema extends z.ZodTypeAny> = Omit<
  RequestOptions<TSchema>,
  'method' | 'body'
>;

export interface HttpClient {
  request<TSchema extends z.ZodTypeAny>(
    path: string,
    options: RequestOptions<TSchema> & { schema: TSchema },
  ): Promise<z.infer<TSchema>>;
  request(path: string, options?: RequestOptions): Promise<unknown>;

  get<TSchema extends z.ZodTypeAny>(
    path: string,
    options: BodylessOptions<TSchema> & { schema: TSchema },
  ): Promise<z.infer<TSchema>>;
  get(path: string, options?: BodylessOptions<z.ZodTypeAny>): Promise<unknown>;

  post<TSchema extends z.ZodTypeAny>(
    path: string,
    body: unknown,
    options: BodylessOptions<TSchema> & { schema: TSchema },
  ): Promise<z.infer<TSchema>>;
  post(path: string, body?: unknown, options?: BodylessOptions<z.ZodTypeAny>): Promise<unknown>;

  patch<TSchema extends z.ZodTypeAny>(
    path: string,
    body: unknown,
    options: BodylessOptions<TSchema> & { schema: TSchema },
  ): Promise<z.infer<TSchema>>;
  patch(path: string, body?: unknown, options?: BodylessOptions<z.ZodTypeAny>): Promise<unknown>;

  put<TSchema extends z.ZodTypeAny>(
    path: string,
    body: unknown,
    options: BodylessOptions<TSchema> & { schema: TSchema },
  ): Promise<z.infer<TSchema>>;
  put(path: string, body?: unknown, options?: BodylessOptions<z.ZodTypeAny>): Promise<unknown>;

  delete<TSchema extends z.ZodTypeAny>(
    path: string,
    options: BodylessOptions<TSchema> & { schema: TSchema },
  ): Promise<z.infer<TSchema>>;
  delete(path: string, options?: BodylessOptions<z.ZodTypeAny>): Promise<unknown>;

  /** Escape hatch for streaming and binary responses: no parsing, no retry. */
  raw(method: HttpMethod, path: string, options?: RequestOptions): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 300, maxDelayMs: 5_000 };
const DEFAULT_TIMEOUT_MS = 15_000;

/** crypto.randomUUID exists in browsers, Node 22 and Hermes. */
const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ApiError('internal_error', { detail: 'Request aborted' }));
      },
      { once: true },
    );
  });

/** Full jitter: spreads a thundering herd instead of synchronising it. */
const backoffDelay = (attempt: number, policy: RetryPolicy): number => {
  const exponential = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  return Math.random() * exponential;
};

const buildUrl = (baseUrl: string, path: string, query?: RequestOptions['query']): string => {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${qs}`;
};

const isFormData = (value: unknown): value is FormData =>
  typeof FormData !== 'undefined' && value instanceof FormData;

/**
 * A transport failure — DNS, TLS, connection reset, timeout. Indistinguishable
 * from each other through fetch, and all equally worth retrying.
 */
const asNetworkError = (cause: unknown, traceId: string): ApiError =>
  new ApiError('dependency_unavailable', {
    title: 'Network unavailable',
    detail: 'The request did not reach the server.',
    traceId,
    cause,
  });

const statusToCode = (status: number): ErrorCode => {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 413) return 'payload_too_large';
  if (status === 426) return 'unsupported_contract_version';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'dependency_unavailable';
  return 'internal_error';
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createHttpClient = (options: HttpClientOptions): HttpClient => {
  const {
    baseUrl,
    auth,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    contractVersion = CONTRACT_VERSION,
    credentials = 'include',
    defaultHeaders = {},
    onRequest,
    onResponse,
    onContractMismatch,
  } = options;

  if (!fetchImpl) {
    throw new Error('No fetch implementation available; pass options.fetchImpl');
  }

  const retryDefaults: RetryPolicy = { ...DEFAULT_RETRY, ...options.retry };

  /**
   * Single-flight refresh. Ten parallel requests that all see a 401 must
   * produce one refresh, not ten — otherwise the rotating refresh token
   * invalidates itself and signs the user out.
   */
  let refreshInFlight: Promise<string | null> | null = null;

  const refreshOnce = (): Promise<string | null> => {
    if (!auth) return Promise.resolve(null);
    refreshInFlight ??= auth
      .refresh()
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
    return refreshInFlight;
  };

  const buildHeaders = async (
    method: HttpMethod,
    requestOptions: RequestOptions,
    requestId: string,
    traceId: string,
  ): Promise<Record<string, string>> => {
    const headers: Record<string, string> = {
      accept: 'application/json',
      [HEADERS.contractVersion]: contractVersion,
      [HEADERS.requestId]: requestId,
      [HEADERS.traceId]: traceId,
      ...defaultHeaders,
      ...requestOptions.headers,
    };

    if (requestOptions.idempotencyKey) {
      headers[HEADERS.idempotencyKey] = requestOptions.idempotencyKey;
    }

    if (!requestOptions.anonymous && auth) {
      const token = await auth.getAccessToken();
      if (token) headers.authorization = `Bearer ${token}`;
      const csrf = auth.getCsrfToken?.();
      if (csrf && method !== 'GET') headers[HEADERS.csrfToken] = csrf;
    }

    return headers;
  };

  const encodeBody = (
    method: HttpMethod,
    value: unknown,
    headers: Record<string, string>,
  ): BodyInit | undefined => {
    if (value === undefined || method === 'GET') return undefined;
    if (isFormData(value) || typeof value === 'string') return value as BodyInit;
    headers['content-type'] = 'application/json';
    return JSON.stringify(value);
  };

  const parseErrorBody = async (response: Response, traceId: string): Promise<ApiError> => {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (body && typeof body === 'object' && 'code' in (body as Record<string, unknown>)) {
      const error = ApiError.fromResponse(body);
      // Prefer the server's trace id; fall back to ours so nothing is unlinked.
      if (!error.traceId) error.traceId = traceId;
      return error;
    }

    // A response that is not shaped like an ApiError came from a proxy or the
    // load balancer, not from the application.
    return new ApiError(statusToCode(response.status), {
      detail: `Unexpected response (${response.status})`,
      traceId,
    });
  };

  async function raw(
    method: HttpMethod,
    path: string,
    requestOptions: RequestOptions = {},
  ): Promise<Response> {
    const requestId = newId();
    const traceId = newId().replaceAll('-', '');
    const headers = await buildHeaders(method, requestOptions, requestId, traceId);
    const body = encodeBody(method, requestOptions.body, headers);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestOptions.timeoutMs ?? timeoutMs);
    const onAbort = () => controller.abort();
    requestOptions.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      return await fetchImpl(buildUrl(baseUrl, path, requestOptions.query), {
        method,
        headers,
        body,
        credentials,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      requestOptions.signal?.removeEventListener('abort', onAbort);
    }
  }

  async function request(path: string, requestOptions: RequestOptions = {}): Promise<unknown> {
    const method = requestOptions.method ?? 'GET';
    const retry: RetryPolicy = { ...retryDefaults, ...requestOptions.retry };
    const url = buildUrl(baseUrl, path, requestOptions.query);

    /** Stable across retries: one logical request, one trace. */
    const traceId = newId().replaceAll('-', '');
    const canRetry = IDEMPOTENT_METHODS.has(method) || Boolean(requestOptions.idempotencyKey);

    let refreshed = false;
    let lastError: ApiError | undefined;

    for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
      const requestId = newId();
      const startedAt = Date.now();

      const headers = await buildHeaders(method, requestOptions, requestId, traceId);
      const body = encodeBody(method, requestOptions.body, headers);

      // Own controller per attempt, chained to the caller's signal so an abort
      // upstream stops the retry loop as well as the in-flight fetch.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestOptions.timeoutMs ?? timeoutMs);
      const onAbort = () => controller.abort();
      requestOptions.signal?.addEventListener('abort', onAbort, { once: true });

      onRequest?.({ method, path, requestId, traceId, attempt });

      try {
        const response = await fetchImpl(url, {
          method,
          headers,
          body,
          credentials,
          signal: controller.signal,
        });

        if (response.ok) {
          onResponse?.({
            method,
            path,
            requestId,
            traceId,
            attempt,
            status: response.status,
            durationMs: Date.now() - startedAt,
          });

          if (response.status === 204) return undefined;
          const json: unknown = await response.json().catch(() => undefined);
          return requestOptions.schema ? requestOptions.schema.parse(json) : json;
        }

        const error = await parseErrorBody(response, traceId);
        onResponse?.({
          method,
          path,
          requestId,
          traceId,
          attempt,
          status: response.status,
          durationMs: Date.now() - startedAt,
          error: error.code,
        });

        if (error.code === 'unsupported_contract_version') {
          onContractMismatch?.(response.headers.get(HEADERS.contractVersion));
          throw error;
        }

        // One refresh, one replay. A second 401 means the session is gone.
        if (
          response.status === 401 &&
          error.code !== 'token_revoked' &&
          !refreshed &&
          !requestOptions.anonymous &&
          auth
        ) {
          refreshed = true;
          const token = await refreshOnce();
          if (token) continue;
          auth.onSessionExpired?.();
          throw error;
        }

        if (response.status === 401) {
          auth?.onSessionExpired?.();
          throw error;
        }

        const retryable = canRetry && isRetryable(error.code) && attempt < retry.attempts;
        if (!retryable) throw error;

        lastError = error;
        // Honour Retry-After when the server sent one; it knows better.
        const delay = error.retryAfter ? error.retryAfter * 1000 : backoffDelay(attempt, retry);
        await sleep(delay, requestOptions.signal);
        continue;
      } catch (cause) {
        if (ApiError.is(cause)) throw cause;

        // Caller aborted deliberately: not a failure to report or retry.
        if (requestOptions.signal?.aborted) {
          throw new ApiError('internal_error', { detail: 'Request cancelled', traceId, cause });
        }

        const networkError = asNetworkError(cause, traceId);
        onResponse?.({
          method,
          path,
          requestId,
          traceId,
          attempt,
          status: 0,
          durationMs: Date.now() - startedAt,
          error: networkError.code,
        });

        // A timeout or a dropped connection is retryable for any method: the
        // server may never have seen the request at all.
        if (attempt < retry.attempts) {
          lastError = networkError;
          await sleep(backoffDelay(attempt, retry), requestOptions.signal);
          continue;
        }
        throw networkError;
      } finally {
        clearTimeout(timer);
        requestOptions.signal?.removeEventListener('abort', onAbort);
      }
    }

    throw lastError ?? new ApiError('internal_error', { detail: 'Request failed', traceId });
  }

  const client = {
    request,
    raw,
    get: (path: string, opts: RequestOptions = {}) => request(path, { ...opts, method: 'GET' }),
    post: (path: string, body?: unknown, opts: RequestOptions = {}) =>
      request(path, { ...opts, method: 'POST', body }),
    patch: (path: string, body?: unknown, opts: RequestOptions = {}) =>
      request(path, { ...opts, method: 'PATCH', body }),
    put: (path: string, body?: unknown, opts: RequestOptions = {}) =>
      request(path, { ...opts, method: 'PUT', body }),
    delete: (path: string, opts: RequestOptions = {}) =>
      request(path, { ...opts, method: 'DELETE' }),
  };

  return client as unknown as HttpClient;
};