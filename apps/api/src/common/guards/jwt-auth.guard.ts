import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '@ham/types';
import { IS_PUBLIC_KEY } from '../decorators';
import { AppError } from '../errors/app-error';
import { loadConfig } from '../../config/env';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly config = loadConfig();
  constructor(private readonly jwt: JwtService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw AppError.tokenInvalid('Missing bearer token.');

    try {
      const p = await this.jwt.verifyAsync(header.slice(7), { secret: this.config.JWT_SECRET });
      req.user = {
        id: p.sub, email: p.email, name: p.name, role: p.role,
        doctorId: p.doctorId, patientId: p.patientId,
      } satisfies AuthUser;
      return true;
    } catch {
      throw AppError.tokenInvalid();
    }
  }
}
