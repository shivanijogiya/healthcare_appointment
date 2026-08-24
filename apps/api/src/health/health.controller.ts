import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ping, type Db } from '@ham/db';
import { DB } from '../db/db.module';
import { Public } from '../common/decorators';
import { RedisService } from '../queue/redis.service';
import { LlmService } from '../llm/llm.service';
import { QueueService } from '../queue/queue.service';
import { OutboxService } from '../notifications/outbox.service';
import { CalendarService } from '../calendar/calendar.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly redis: RedisService,
    private readonly llm: LlmService,
    private readonly queue: QueueService,
    private readonly outbox: OutboxService,
    private readonly calendar: CalendarService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness and dependency status' })
  async health() {
    const [database, redis] = await Promise.all([
      ping(this.db).then(() => 'up').catch((e) => `down: ${e.message}`),
      this.redis.ping().then(() => 'up').catch((e) => `down: ${e.message}`),
    ]);

    // The LLM being down is explicitly not an unhealthy system: booking,
    // cancellation and note submission all work without it.
    const degraded = database !== 'up' || redis !== 'up';

    return {
      status: degraded ? 'degraded' : 'ok',
      time: new Date().toISOString(),
      database,
      redis,
      llm: this.llm.breakerState,
      calendar: { configured: this.calendar.enabled },
      notifications: await this.outbox.stats().catch(() => ({})),
    };
  }

  @Public()
  @Get('queues')
  @ApiOperation({ summary: 'Queue depths, for debugging the worker' })
  queues() { return this.queue.counts(); }
}
