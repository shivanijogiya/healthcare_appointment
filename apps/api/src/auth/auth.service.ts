import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import type { Db } from '@ham/db';
import type { AuthResponse, AuthUser, Role } from '@ham/types';
import { DB } from '../db/db.module';
import { loadConfig } from '../config/env';
import { AppError } from '../common/errors/app-error';
import { CryptoService } from '../common/crypto.service';
import { AuditService } from '../common/audit.service';
import { RegisterDto } from './dto';

@Injectable()
export class AuthService {
  private readonly config = loadConfig();
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  /** Only patients may self-register. Doctors and admins are created by an admin. */
  async register(dto: RegisterDto): Promise<AuthResponse> {
    const email = dto.email.toLowerCase().trim();
    const existing = await this.db
      .selectFrom('app_user').select('id').where('email', '=', email).executeTakeFirst();
    if (existing) throw AppError.conflict('An account with that email already exists.');

    const user = await this.db.transaction().execute(async (trx) => {
      const u = await trx
        .insertInto('app_user')
        .values({
          email,
          name: dto.name.trim(),
          phone: dto.phone ?? null,
          role: 'PATIENT',
          password_hash: await bcrypt.hash(dto.password, 10),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('patient')
        .values({ user_id: u.id, date_of_birth: dto.dateOfBirth ?? null, gender: dto.gender ?? null })
        .execute();
      return u;
    });

    await this.audit.record({ action: 'auth.register', entity: 'app_user', entityId: user.id });
    return this.issue(await this.hydrate(user.id));
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    const user = await this.db
      .selectFrom('app_user').selectAll().where('email', '=', email.toLowerCase().trim()).executeTakeFirst();
    // Constant-ish work whether or not the user exists, to avoid a timing oracle.
    const hash = user?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const ok = await bcrypt.compare(password, hash);
    if (!user || !ok) throw AppError.invalidCredentials();
    return this.issue(await this.hydrate(user.id));
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.JWT_REFRESH_SECRET,
      });
    } catch {
      throw AppError.tokenInvalid();
    }
    const tokenHash = this.crypto.sha256(refreshToken);
    const row = await this.db
      .selectFrom('refresh_token').selectAll()
      .where('token_hash', '=', tokenHash)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .executeTakeFirst();
    if (!row) throw AppError.tokenInvalid('This session is no longer valid.');

    // Rotate: a refresh token is single-use, so a stolen one is detectable.
    await this.db.updateTable('refresh_token')
      .set({ revoked_at: new Date() }).where('id', '=', row.id).execute();
    return this.issue(await this.hydrate(payload.sub));
  }

  async logout(refreshToken: string): Promise<void> {
    await this.db.updateTable('refresh_token')
      .set({ revoked_at: new Date() })
      .where('token_hash', '=', this.crypto.sha256(refreshToken))
      .execute();
  }

  async hydrate(userId: string): Promise<AuthUser> {
    const row = await this.db
      .selectFrom('app_user')
      .leftJoin('doctor', 'doctor.user_id', 'app_user.id')
      .leftJoin('patient', 'patient.user_id', 'app_user.id')
      .select([
        'app_user.id as id', 'app_user.email as email', 'app_user.name as name',
        'app_user.role as role', 'doctor.id as doctorId', 'patient.id as patientId',
      ])
      .where('app_user.id', '=', userId)
      .executeTakeFirst();
    if (!row) throw AppError.tokenInvalid();
    return {
      id: row.id, email: row.email, name: row.name, role: row.role as Role,
      doctorId: row.doctorId ?? undefined, patientId: row.patientId ?? undefined,
    };
  }

  private async issue(user: AuthUser): Promise<AuthResponse> {
    const claims = {
      sub: user.id, email: user.email, name: user.name, role: user.role,
      doctorId: user.doctorId, patientId: user.patientId,
    };
    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.config.JWT_SECRET,
      expiresIn: this.config.JWT_ACCESS_TTL,
    });
    const days = Number((this.config.JWT_REFRESH_TTL.match(/^(\d+)d$/) ?? [,'7'])[1]);
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, jti: randomBytes(16).toString('hex') },
      { secret: this.config.JWT_REFRESH_SECRET, expiresIn: `${days}d` },
    );
    await this.db.insertInto('refresh_token').values({
      user_id: user.id,
      token_hash: this.crypto.sha256(refreshToken),
      expires_at: new Date(Date.now() + days * 86_400_000),
    }).execute();
    return { accessToken, refreshToken, user };
  }
}
