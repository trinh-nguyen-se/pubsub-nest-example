import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { safeEqual } from '../common/safe-equal';
import { CONFIG, type AppConfig } from '../config';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (safeEqual(request.header('x-admin-token') ?? '', this.config.adminToken)) return true;
    throw new ForbiddenException('x-admin-token không hợp lệ');
  }
}
