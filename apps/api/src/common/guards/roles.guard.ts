import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@ham/types';
import { ROLES_KEY } from '../decorators';
import { AppError } from '../errors/app-error';

/**
 * Coarse role gate only. Ownership ("is this YOUR appointment?") is deliberately
 * checked in the service layer against the database — a doctor holding a valid
 * DOCTOR token must still be refused another doctor's patient.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required?.length) return true;
    const user = ctx.switchToHttp().getRequest().user;
    if (!user || !required.includes(user.role)) {
      throw AppError.forbidden(`This action requires the ${required.join(' or ')} role.`);
    }
    return true;
  }
}
