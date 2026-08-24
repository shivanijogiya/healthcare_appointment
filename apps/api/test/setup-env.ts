process.env.DATABASE_URL ??= 'postgresql://ham:ham@127.0.0.1:5432/ham';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.CLINIC_TIMEZONE_OFFSET_MINUTES ??= '330';
process.env.LLM_PROVIDER ??= 'mock';
process.env.MAIL_TRANSPORT ??= 'file';
