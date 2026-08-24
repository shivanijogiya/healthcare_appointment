import { HttpException } from '@nestjs/common';
import { ErrorCode } from '@ham/types';

/**
 * Every failure the client is expected to branch on is thrown as an AppError so
 * the response body always carries a stable `code`. Prose is for humans only.
 */
export class AppError extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    status: number,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }

  static slotTaken(detail?: unknown) {
    return new AppError(ErrorCode.SLOT_TAKEN, 'That slot has just been taken. Pick another time.', 409, detail);
  }
  static patientDoubleBooked() {
    return new AppError(ErrorCode.PATIENT_DOUBLE_BOOKED, 'You already have an appointment overlapping this time.', 409);
  }
  static slotUnavailable(reason: string) {
    return new AppError(ErrorCode.SLOT_UNAVAILABLE, reason, 409);
  }
  static holdExpired() {
    return new AppError(ErrorCode.HOLD_EXPIRED, 'This hold has expired. Choose the slot again.', 410);
  }
  static intakeRequired() {
    return new AppError(ErrorCode.INTAKE_REQUIRED, 'Complete the symptom form before confirming.', 422);
  }
  static leaveConflict(details: unknown) {
    return new AppError(ErrorCode.LEAVE_CONFLICT, 'A replacement slot conflicts with an existing booking.', 409, details);
  }
  static forbidden(message = 'You do not have access to this resource.') {
    return new AppError(ErrorCode.FORBIDDEN_RESOURCE, message, 403);
  }
  static notFound(what = 'Resource') {
    return new AppError(ErrorCode.NOT_FOUND, `${what} not found.`, 404);
  }
  static invalidCredentials() {
    return new AppError(ErrorCode.INVALID_CREDENTIALS, 'Email or password is incorrect.', 401);
  }
  static tokenInvalid(message = 'Session expired. Sign in again.') {
    return new AppError(ErrorCode.TOKEN_INVALID, message, 401);
  }
  static conflict(message: string) {
    return new AppError(ErrorCode.CONFLICT, message, 409);
  }
  static calendarNotConnected() {
    return new AppError(ErrorCode.CALENDAR_NOT_CONNECTED, 'Google Calendar is not connected for this account.', 409);
  }
  static llmUnavailable() {
    return new AppError(ErrorCode.LLM_UNAVAILABLE, 'The summary service is unavailable.', 503);
  }
}

/** Thrown inside the LLM module; never surfaces to a booking request. */
export class LlmUnavailableError extends Error {
  constructor(message = 'LLM unavailable', public readonly retryable = true) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}
