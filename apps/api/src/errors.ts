import { ERROR_CODES } from '@club-registration/shared';
import type { ErrorCode } from '@club-registration/shared';

const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  [ERROR_CODES.badRequest]: 400,
  [ERROR_CODES.validationError]: 400,
  [ERROR_CODES.invalidCurrentPassword]: 400,
  [ERROR_CODES.unauthorized]: 401,
  [ERROR_CODES.invalidCredentials]: 401,
  [ERROR_CODES.forbidden]: 403,
  [ERROR_CODES.passwordChangeRequired]: 403,
  [ERROR_CODES.notFound]: 404,
  [ERROR_CODES.roundExists]: 409,
  [ERROR_CODES.roundNotEmpty]: 409,
  [ERROR_CODES.fileTooLarge]: 413,
  [ERROR_CODES.unsupportedFile]: 415,
  [ERROR_CODES.invalidWorkbook]: 400,
  [ERROR_CODES.importFileMismatch]: 409,
  [ERROR_CODES.importInvalid]: 422,
  [ERROR_CODES.importConflict]: 409,
  [ERROR_CODES.rateLimited]: 429,
  [ERROR_CODES.internalError]: 500,
});

const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  [ERROR_CODES.badRequest]: 'Invalid request',
  [ERROR_CODES.validationError]: 'Request failed validation',
  [ERROR_CODES.invalidCurrentPassword]: 'Current password is incorrect',
  [ERROR_CODES.unauthorized]: 'Authentication required',
  [ERROR_CODES.invalidCredentials]: 'Invalid login ID or password',
  [ERROR_CODES.forbidden]: 'Not allowed',
  [ERROR_CODES.passwordChangeRequired]: 'Password must be changed first',
  [ERROR_CODES.notFound]: 'Not found',
  [ERROR_CODES.roundExists]: 'A round for this term and grade already exists',
  [ERROR_CODES.roundNotEmpty]: 'Round still has clubs or other data attached',
  [ERROR_CODES.fileTooLarge]: 'File is larger than the import limit',
  [ERROR_CODES.unsupportedFile]: 'Only .xlsx files are accepted',
  [ERROR_CODES.invalidWorkbook]: 'The file could not be read as an Excel workbook',
  [ERROR_CODES.importFileMismatch]: 'The file differs from the previewed one; preview it again',
  [ERROR_CODES.importInvalid]: 'The file has errors; nothing was imported',
  [ERROR_CODES.importConflict]:
    'Data changed while importing (e.g. registrations above the new capacity); preview again',
  [ERROR_CODES.rateLimited]: 'Too many requests, try again later',
  [ERROR_CODES.internalError]: 'Internal server error',
});

// Services throw this; only the error handler turns it into an HTTP response.
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(code: ErrorCode, message: string = DEFAULT_MESSAGES[code]) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = HTTP_STATUS[code];
  }
}
