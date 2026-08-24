import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorCode } from '@ham/types';
import { AppError } from '../errors/app-error';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = (req as any).requestId;

    if (exception instanceof AppError) {
      const body = exception.getResponse() as any;
      return res.status(exception.getStatus()).json({ ...body, requestId });
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse() as any;
      // class-validator pipe failures arrive here as { message: string[] }
      const isValidation = status === HttpStatus.BAD_REQUEST && Array.isArray(raw?.message);
      return res.status(status).json({
        code: isValidation
          ? ErrorCode.VALIDATION_FAILED
          : status === 401 ? ErrorCode.TOKEN_INVALID
          : status === 403 ? ErrorCode.FORBIDDEN_RESOURCE
          : status === 404 ? ErrorCode.NOT_FOUND
          : ErrorCode.CONFLICT,
        message: isValidation ? 'Some fields need attention.' : (raw?.message ?? exception.message),
        details: isValidation ? raw.message : undefined,
        requestId,
      });
    }

    this.logger.error(
      `Unhandled ${req.method} ${req.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: ErrorCode.INTERNAL,
      message: 'Something went wrong on our side.',
      requestId,
    });
  }
}
