import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';

/**
 * Dữ liệu sai kiểu phải là 400 kèm chi tiết field, không phải 500.
 * Không có filter này, một `POST /admin/suppliers` thiếu field sẽ trả 500 và
 * người gọi tưởng CMS hỏng.
 */
@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(exception: ZodError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'BAD_REQUEST',
      message: 'dữ liệu không hợp lệ',
      issues: exception.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
}
