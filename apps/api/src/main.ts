import './config/load-env';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadConfig } from './config/env';

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
  app.enableCors({
    origin: config.APP_URL.split(',').map((s) => s.trim()),
    credentials: true,
    exposedHeaders: ['x-request-id'],
  });
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,          // strip unknown properties rather than trusting them
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const swagger = new DocumentBuilder()
    .setTitle('Healthcare Appointment & Follow-up Manager')
    .setDescription(
      'Booking, AI pre/post-visit summaries, email and Google Calendar for a multi-doctor clinic. ' +
        'Typed error codes: SLOT_TAKEN, HOLD_EXPIRED, INTAKE_REQUIRED, LEAVE_CONFLICT, FORBIDDEN_RESOURCE.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swagger), {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(config.PORT, '0.0.0.0');
  new Logger('Bootstrap').log(
    `API on :${config.PORT} — docs at /api/docs — mail ${config.MAIL_TRANSPORT} — llm ${config.LLM_PROVIDER}`,
  );
}

bootstrap();
