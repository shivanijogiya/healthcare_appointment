import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import IORedis, { Redis } from 'ioredis';
import { loadConfig } from '../config/env';

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private readonly connections: Redis[] = [];
  private shared?: Redis;
  readonly url = loadConfig().REDIS_URL;

  /** BullMQ requires maxRetriesPerRequest: null on connections it blocks on. */
  create(): Redis {
    const conn = new IORedis(this.url, { maxRetriesPerRequest: null, enableReadyCheck: false });
    conn.on('error', (e) => this.logger.warn(`Redis: ${e.message}`));
    this.connections.push(conn);
    return conn;
  }

  get client(): Redis {
    if (!this.shared) this.shared = this.create();
    return this.shared;
  }

  async ping(): Promise<boolean> {
    return (await this.client.ping()) === 'PONG';
  }

  async onApplicationShutdown() {
    await Promise.allSettled(this.connections.map((c) => c.quit().catch(() => c.disconnect())));
  }
}
