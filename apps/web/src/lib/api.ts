import {
  errorResponseSchema,
  healthResponseSchema,
  roundListResponseSchema,
  roundResponseSchema,
  sessionResponseSchema,
} from '@club-registration/shared';
import type {
  ChangePasswordRequest,
  CreateRoundBatchRequest,
  CreateRoundRequest,
  HealthResponse,
  LoginRequest,
  Round,
  SessionUser,
  UpdateRoundRequest,
} from '@club-registration/shared';

const UNAUTHORIZED = 401;
const SERVICE_UNAVAILABLE = 503;

type Parser<T> = { parse: (data: unknown) => T };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const toApiError = async (response: Response): Promise<ApiError> => {
  // A proxy or crash page may answer with HTML, so a non-JSON body still becomes an ApiError.
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = errorResponseSchema.safeParse(body);
  return parsed.success
    ? new ApiError(response.status, parsed.data.code, parsed.data.message)
    : new ApiError(response.status, 'unknown', `Unexpected status ${response.status}`);
};

const send = async (path: string, method: string, body?: unknown): Promise<Response> => {
  // Content-Type only with a body: Fastify rejects an empty body declared as JSON.
  const init: RequestInit =
    body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const response = await fetch(path, init);
  if (!response.ok) throw await toApiError(response);
  return response;
};

const sendJson = async <T>(
  path: string,
  method: string,
  schema: Parser<T>,
  body?: unknown,
): Promise<T> => schema.parse(await (await send(path, method, body)).json());

export const fetchHealth = async (): Promise<HealthResponse> => {
  const response = await fetch('/api/health');
  // 503 is a valid answer here: the API is up and is reporting that the database is not.
  if (!response.ok && response.status !== SERVICE_UNAVAILABLE) {
    throw new Error(`Unexpected status ${response.status}`);
  }
  return healthResponseSchema.parse(await response.json());
};

// null means "not logged in", which is an expected state rather than an error.
export const fetchSession = async (): Promise<SessionUser | null> => {
  try {
    return (await sendJson('/api/auth/me', 'GET', sessionResponseSchema)).user;
  } catch (error) {
    if (error instanceof ApiError && error.status === UNAUTHORIZED) return null;
    throw error;
  }
};

export const login = async (request: LoginRequest): Promise<SessionUser> =>
  (await sendJson('/api/auth/login', 'POST', sessionResponseSchema, request)).user;

export const changePassword = async (request: ChangePasswordRequest): Promise<SessionUser> =>
  (await sendJson('/api/auth/change-password', 'POST', sessionResponseSchema, request)).user;

export const logout = async (): Promise<void> => {
  await send('/api/auth/logout', 'POST');
};

export const fetchRounds = async (term?: string): Promise<Round[]> => {
  const query = term ? `?${new URLSearchParams({ term }).toString()}` : '';
  return (await sendJson(`/api/admin/rounds${query}`, 'GET', roundListResponseSchema)).rounds;
};

export const createRound = async (request: CreateRoundRequest): Promise<Round> =>
  (await sendJson('/api/admin/rounds', 'POST', roundResponseSchema, request)).round;

export const createRoundBatch = async (request: CreateRoundBatchRequest): Promise<Round[]> =>
  (await sendJson('/api/admin/rounds/batch', 'POST', roundListResponseSchema, request)).rounds;

export const updateRound = async (id: number, request: UpdateRoundRequest): Promise<Round> =>
  (await sendJson(`/api/admin/rounds/${id}`, 'PATCH', roundResponseSchema, request)).round;

export const deleteRound = async (id: number): Promise<void> => {
  await send(`/api/admin/rounds/${id}`, 'DELETE');
};
