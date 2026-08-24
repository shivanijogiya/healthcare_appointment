import './config/load-env';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';

/**
 * Separate process, same image. Run with `npm run start:worker`.
 * A crashed reminder job must never take booking down with it.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  app.enableShutdownHooks();
  new Logger('Worker').log('Background worker started');
}

bootstrap();
