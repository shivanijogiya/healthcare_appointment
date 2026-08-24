import { z } from 'zod';

const bool = (def: string) =>
  z
    .string()
    .default(def)
    .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  APP_URL: z.string().default('http://localhost:5173'),
  API_URL: z.string().default('http://localhost:3000'),
  CLINIC_TIMEZONE_OFFSET_MINUTES: z.coerce.number().default(330), // IST default

  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(8).default('dev-access-secret-change-me'),
  JWT_REFRESH_SECRET: z.string().min(8).default('dev-refresh-secret-change-me'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  ENCRYPTION_KEY: z
    .string()
    .default('0'.repeat(64)), // 32-byte hex

  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'mock', 'failing']).default('mock'),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('claude-sonnet-4-5'),
  LLM_BASE_URL: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().default(15000),
  LLM_MAX_ATTEMPTS: z.coerce.number().default(3),
  LLM_BREAKER_THRESHOLD: z.coerce.number().default(5),
  LLM_BREAKER_COOLDOWN_MS: z.coerce.number().default(60000),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: bool('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Clinic <noreply@clinic.example>'),
  MAIL_TRANSPORT: z.enum(['smtp', 'file', 'failing']).default('file'),
  MAIL_OUTPUT_DIR: z.string().default('./tmp/mail'),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().default('http://localhost:3000/calendar/callback'),

  SLOT_HOLD_TTL_MINUTES: z.coerce.number().default(10),
  REMINDER_HOURS_BEFORE: z.coerce.number().default(24),
  MEDICATION_REMINDER_MAX_DAYS: z.coerce.number().default(90),
  MAX_ADVANCE_BOOKING_DAYS: z.coerce.number().default(60),
  RUN_WORKER_INLINE: bool('false'),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export const CONFIG = 'APP_CONFIG';
