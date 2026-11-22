import {
  ISSUED_COUNT_HEADER,
  adminClubResponseSchema,
  clubMemberWriteResponseSchema,
  clubMembersResponseSchema,
  clubWaitlistResponseSchema,
  errorResponseSchema,
  eventLogResponseSchema,
  healthResponseSchema,
  importCommitResponseSchema,
  importPreviewResponseSchema,
  passwordStatusResponseSchema,
  roundClassroomsResponseSchema,
  roundListResponseSchema,
  roundClubsResponseSchema,
  roundResponseSchema,
  sessionResponseSchema,
  studentClubsResponseSchema,
  studentQueueResponseSchema,
  studentRegistrationResponseSchema,
  studentRoundResponseSchema,
  studentWaitlistResponseSchema,
} from '@club-registration/shared';
import type {
  AdminClub,
  CancelRegistrationRequest,
  ChangePasswordRequest,
  ClubMemberRequest,
  ClubMemberWriteResponse,
  ClubMembersResponse,
  ClubWaitlistRemoveRequest,
  ClubWaitlistResponse,
  ChangeRegistrationRequest,
  ClassroomPasswordStatus,
  CreateRoundBatchRequest,
  CreateRoundRequest,
  EventLogResponse,
  ExportQuery,
  HealthResponse,
  ImportCommitResponse,
  ImportPreviewResponse,
  IssueInitialPasswordsRequest,
  JoinWaitlistRequest,
  LeaveWaitlistRequest,
  LoginRequest,
  RegisterRequest,
  Round,
  RoundClassroomsResponse,
  RoundClubsResponse,
  SessionUser,
  StudentClubsResponse,
  StudentQueueResponse,
  StudentRegistrationResponse,
  StudentRoundResponse,
  StudentWaitlistResponse,
  UpdateClubRequest,
  UpdateRoundRequest,
} from '@club-registration/shared';

const UNAUTHORIZED = 401;
const SERVER_ERROR = 500;
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

// No answer from our server (network down, proxy gateway error, unreadable reply) means the write
// may have been applied with only the reply lost. Retrying with the same idempotency key is then
// the one safe move: the server replays it instead of acting twice. A 500 from the API itself has
// rolled back, so the same key is simply processed again.
export const isOutcomeUnknown = (error: unknown): boolean =>
  !(error instanceof ApiError) || error.status >= SERVER_ERROR;

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

export const fetchRoundClubs = async (roundId: number): Promise<RoundClubsResponse> =>
  await sendJson(`/api/admin/rounds/${roundId}/clubs`, 'GET', roundClubsResponseSchema);

export const fetchRoundClassrooms = async (roundId: number): Promise<RoundClassroomsResponse> =>
  await sendJson(`/api/admin/rounds/${roundId}/classrooms`, 'GET', roundClassroomsResponseSchema);

export const updateClub = async (id: number, request: UpdateClubRequest): Promise<AdminClub> =>
  (await sendJson(`/api/admin/clubs/${id}`, 'PATCH', adminClubResponseSchema, request)).club;

// An admin's view of a club's members and waitlist, and the writes that fix them in the
// students' place (README Phase 2, PR 3a and 3b). Allowed in every round status. The member
// writes answer with the student's seat in this club after every promotion they caused (null =
// not in this club now), the waitlist removal with the whole queue after it.
export const fetchClubMembers = async (clubId: number): Promise<ClubMembersResponse> =>
  await sendJson(`/api/admin/clubs/${clubId}/members`, 'GET', clubMembersResponseSchema);

export const assignClubMember = async (
  clubId: number,
  request: ClubMemberRequest,
): Promise<ClubMemberWriteResponse> =>
  await sendJson(
    `/api/admin/clubs/${clubId}/members`,
    'POST',
    clubMemberWriteResponseSchema,
    request,
  );

export const removeClubMember = async (
  clubId: number,
  request: ClubMemberRequest,
): Promise<ClubMemberWriteResponse> =>
  await sendJson(
    `/api/admin/clubs/${clubId}/members/remove`,
    'POST',
    clubMemberWriteResponseSchema,
    request,
  );

export const fetchClubWaitlist = async (clubId: number): Promise<ClubWaitlistResponse> =>
  await sendJson(`/api/admin/clubs/${clubId}/waitlist`, 'GET', clubWaitlistResponseSchema);

export const removeClubWaitlistEntry = async (
  clubId: number,
  request: ClubWaitlistRemoveRequest,
): Promise<ClubWaitlistResponse> =>
  await sendJson(
    `/api/admin/clubs/${clubId}/waitlist/remove`,
    'POST',
    clubWaitlistResponseSchema,
    request,
  );

// The filters the admin event log page sets; unset ones are left out of the URL. before is the
// cursor (the nextBefore of the page before). The page size is the API's default.
export type EventLogRequest = {
  roundId?: number | undefined;
  clubId?: number | undefined;
  loginId?: string | undefined;
  before?: number | undefined;
};

// Fixed parameter order, so the same filters always ask for the same URL. The loginId is a
// student's code: the api logs only parameter names (apps/api/src/log.ts) and this URL is
// fetch's, never the page's, so it stays out of the browser history.
const eventLogSearch = ({ roundId, clubId, loginId, before }: EventLogRequest): string =>
  new URLSearchParams(
    [
      ['roundId', roundId === undefined ? undefined : String(roundId)],
      ['clubId', clubId === undefined ? undefined : String(clubId)],
      ['loginId', loginId],
      ['before', before === undefined ? undefined : String(before)],
    ].filter((entry): entry is [string, string] => entry[1] !== undefined),
  ).toString();

export const fetchEvents = async (request: EventLogRequest): Promise<EventLogResponse> => {
  const search = eventLogSearch(request);
  return await sendJson(
    `/api/admin/events${search === '' ? '' : `?${search}`}`,
    'GET',
    eventLogResponseSchema,
  );
};

export const IMPORT_TEMPLATE_URL = '/api/admin/import/template';

// The browser sets the multipart boundary itself, so no content-type is given here. Fields go
// first so the server meets them before the file.
const sendForm = async <T>(
  path: string,
  fields: Record<string, string>,
  file: File,
  schema: Parser<T>,
): Promise<T> => {
  const body = new FormData();
  Object.entries(fields).forEach(([name, value]) => body.append(name, value));
  body.append('file', file);
  const response = await fetch(path, { method: 'POST', body });
  if (!response.ok) throw await toApiError(response);
  return schema.parse(await response.json());
};

export const previewImport = async (term: string, file: File): Promise<ImportPreviewResponse> =>
  await sendForm('/api/admin/import/preview', { term }, file, importPreviewResponseSchema);

export type CommitImportRequest = {
  term: string;
  file: File;
  fileSha256: string;
  idempotencyKey: string;
};

// Sends the previewed file again: the server keeps nothing between preview and commit, and
// refuses the commit if the bytes no longer match fileSha256.
export const commitImport = async ({
  term,
  file,
  fileSha256,
  idempotencyKey,
}: CommitImportRequest): Promise<ImportCommitResponse> =>
  await sendForm(
    '/api/admin/import/commit',
    { term, fileSha256, idempotencyKey },
    file,
    importCommitResponseSchema,
  );

export const fetchPasswordStatus = async (): Promise<ClassroomPasswordStatus[]> =>
  (await sendJson('/api/admin/students/password-status', 'GET', passwordStatusResponseSchema))
    .classrooms;

export type DownloadedFile = { file: Blob; filename: string };
export type IssuedPasswordFile = DownloadedFile & { issuedCount: number };

const DEFAULT_PASSWORD_FILENAME = 'initial-passwords.xlsx';

// The server names a file after its scope only; anything unexpected falls back to a fixed name.
const attachmentFilename = (disposition: string | null, fallback: string): string =>
  /filename="([A-Za-z0-9._-]+)"/.exec(disposition ?? '')?.[1] ?? fallback;

// The answer is the .xlsx itself, the only copy of the new passwords anywhere.
export const issueInitialPasswords = async (
  request: IssueInitialPasswordsRequest,
): Promise<IssuedPasswordFile> => {
  const response = await send('/api/admin/students/initial-passwords', 'POST', request);
  return {
    file: await response.blob(),
    filename: attachmentFilename(
      response.headers.get('content-disposition'),
      DEFAULT_PASSWORD_FILENAME,
    ),
    issuedCount: Number(response.headers.get(ISSUED_COUNT_HEADER) ?? 0),
  };
};

// Fixed parameter order (view, scope, format) so the same choice always asks for the same URL.
const exportSearch = (query: ExportQuery): string => {
  const scope: [string, string][] =
    query.view === 'club'
      ? query.clubId === undefined
        ? []
        : [['clubId', String(query.clubId)]]
      : query.classroom === undefined
        ? []
        : [['classroom', query.classroom]];
  return new URLSearchParams([['view', query.view], ...scope, ['format', query.format]]).toString();
};

// A read: downloading the same list twice is harmless, so no idempotency key.
export const downloadNameList = async (
  roundId: number,
  query: ExportQuery,
): Promise<DownloadedFile> => {
  const response = await send(`/api/admin/rounds/${roundId}/export?${exportSearch(query)}`, 'GET');
  return {
    file: await response.blob(),
    filename: attachmentFilename(
      response.headers.get('content-disposition'),
      `name-list.${query.format}`,
    ),
  };
};

// The student, grade and round come from the session cookie, so these calls take no parameters.
export const fetchStudentRound = async (): Promise<StudentRoundResponse> =>
  await sendJson('/api/student/round', 'GET', studentRoundResponseSchema);

export const fetchStudentClubs = async (): Promise<StudentClubsResponse> =>
  await sendJson('/api/student/clubs', 'GET', studentClubsResponseSchema);

// The registration writes answer with the student's registration as it stands afterwards, the
// waitlist writes with their waitlist entry. Sending the same idempotencyKey again replays the
// first request instead of acting twice.
export const registerForClub = async (
  request: RegisterRequest,
): Promise<StudentRegistrationResponse> =>
  await sendJson('/api/student/registration', 'POST', studentRegistrationResponseSchema, request);

export const cancelRegistration = async (
  request: CancelRegistrationRequest,
): Promise<StudentRegistrationResponse> =>
  await sendJson(
    '/api/student/registration/cancel',
    'POST',
    studentRegistrationResponseSchema,
    request,
  );

// Moves the student's seat to another club in one step; the club left is the one the DB holds.
export const changeRegistration = async (
  request: ChangeRegistrationRequest,
): Promise<StudentRegistrationResponse> =>
  await sendJson('/api/student/registration', 'PUT', studentRegistrationResponseSchema, request);

export const joinWaitlist = async (
  request: JoinWaitlistRequest,
): Promise<StudentWaitlistResponse> =>
  await sendJson('/api/student/waitlist', 'POST', studentWaitlistResponseSchema, request);

export const leaveWaitlist = async (
  request: LeaveWaitlistRequest,
): Promise<StudentWaitlistResponse> =>
  await sendJson('/api/student/waitlist/leave', 'POST', studentWaitlistResponseSchema, request);

// The queue in front of the round (README Phase 3). The bodies are the strict empty object the
// API requires: a JSON body, never a form, so a cross-site page cannot send one. Join and done are
// idempotent by design (no key): joining again answers the live ticket, done again answers done.
const QUEUE_WRITE_BODY = Object.freeze({});

export const joinQueue = async (): Promise<StudentQueueResponse> =>
  await sendJson('/api/student/queue/join', 'POST', studentQueueResponseSchema, QUEUE_WRITE_BODY);

export const queueHeartbeat = async (): Promise<StudentQueueResponse> =>
  await sendJson(
    '/api/student/queue/heartbeat',
    'POST',
    studentQueueResponseSchema,
    QUEUE_WRITE_BODY,
  );

export const releaseQueue = async (): Promise<StudentQueueResponse> =>
  await sendJson('/api/student/queue/done', 'POST', studentQueueResponseSchema, QUEUE_WRITE_BODY);

// A read only: not counted as being present, so it never keeps a ticket alive.
export const fetchQueue = async (): Promise<StudentQueueResponse> =>
  await sendJson('/api/student/queue', 'GET', studentQueueResponseSchema);
