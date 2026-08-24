import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Db } from '@ham/db';
import { DB } from '../db/db.module';
import type { AuthUser } from '@ham/types';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Never throws: an audit write must not fail a business operation. */
  async record(input: {
    actor?: AuthUser | null;
    action: string;
    entity: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.db
        .insertInto('audit_log')
        .values({
          actor_id: input.actor?.id ?? null,
          actor_role: input.actor?.role ?? null,
          action: input.action,
          entity: input.entity,
          entity_id: input.entityId ?? null,
          metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        })
        .execute();
    } catch (e) {
      this.logger.warn(`Audit write failed for ${input.action}: ${(e as Error).message}`);
    }
  }
}
