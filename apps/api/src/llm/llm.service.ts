import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { loadConfig } from '../config/env';
import { CircuitBreaker } from './circuit-breaker';
import { extractJson } from './schemas';
import { backoffMs } from '../scheduling/slot-math';
import { LlmProvider, NonRetryableLlmError, CompletionRequest } from './providers/provider.interface';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAiProvider } from './providers/openai.provider';
import { MockProvider } from './providers/mock.provider';
import { FailingProvider } from './providers/failing.provider';

export class LlmUnavailableError extends Error {
  constructor(message: string, readonly attempts: number) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

export interface GenerateResult<T> {
  value: T;
  raw: string;
  model: string;
  latencyMs: number;
  attempts: number;
}

/**
 * The only place the application talks to a model.
 *
 * Everything defensive lives here — timeout, bounded retry, circuit breaker,
 * fence-stripping, strict schema validation — so that callers can treat a
 * summary as simply "present or absent" and never have to reason about
 * providers. Nothing in this file is ever awaited from an HTTP request that a
 * patient or doctor is waiting on.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly config = loadConfig();
  private readonly provider: LlmProvider;
  private readonly breaker: CircuitBreaker;

  constructor() {
    this.provider = this.buildProvider();
    this.breaker = new CircuitBreaker(
      this.config.LLM_BREAKER_THRESHOLD,
      this.config.LLM_BREAKER_COOLDOWN_MS,
    );
    this.logger.log(`LLM provider: ${this.provider.name} (model ${this.config.LLM_MODEL})`);
  }

  private buildProvider(): LlmProvider {
    switch (this.config.LLM_PROVIDER) {
      case 'anthropic':
        if (!this.config.LLM_API_KEY) {
          this.logger.warn('LLM_PROVIDER=anthropic but LLM_API_KEY is unset — falling back to mock.');
          return new MockProvider();
        }
        return new AnthropicProvider(this.config.LLM_MODEL, this.config.LLM_API_KEY, this.config.LLM_BASE_URL);
      case 'openai':
        if (!this.config.LLM_API_KEY) {
          this.logger.warn('LLM_PROVIDER=openai but LLM_API_KEY is unset — falling back to mock.');
          return new MockProvider();
        }
        return new OpenAiProvider(this.config.LLM_MODEL, this.config.LLM_API_KEY, this.config.LLM_BASE_URL);
      case 'failing':
        return new FailingProvider();
      default:
        return new MockProvider();
    }
  }

  get breakerState() {
    return {
      state: this.breaker.state,
      consecutiveFailures: this.breaker.consecutiveFailures,
      provider: this.provider.name,
      model: this.config.LLM_MODEL,
    };
  }

  /**
   * Runs a completion and validates it against `schema`.
   *
   * A response that parses as JSON but does not match the schema is treated as a
   * failure, not as partial data. Storing a summary with a missing or invented
   * urgency would be worse than storing nothing, because the doctor would trust
   * it.
   */
  async generate<T>(request: CompletionRequest, schema: z.ZodType<T>): Promise<GenerateResult<T>> {
    if (this.breaker.isOpen()) {
      // Fail fast rather than queueing more work behind a provider that is down.
      throw new LlmUnavailableError('Circuit breaker is open', 0);
    }

    const started = Date.now();
    let lastError: unknown;

    for (let attempt = 0; attempt < this.config.LLM_MAX_ATTEMPTS; attempt++) {
      try {
        const raw = await this.callWithDeadline(request);
        const value = schema.parse(extractJson(raw));
        this.breaker.recordSuccess();
        return {
          value,
          raw,
          model: this.config.LLM_MODEL,
          latencyMs: Date.now() - started,
          attempts: attempt + 1,
        };
      } catch (err) {
        lastError = err;
        if (err instanceof NonRetryableLlmError) {
          this.breaker.recordFailure();
          throw new LlmUnavailableError(err.message, attempt + 1);
        }
        const last = attempt === this.config.LLM_MAX_ATTEMPTS - 1;
        this.logger.warn(
          `LLM attempt ${attempt + 1}/${this.config.LLM_MAX_ATTEMPTS} failed: ${(err as Error).message}`,
        );
        if (!last) await this.sleep(backoffMs(attempt));
      }
    }

    this.breaker.recordFailure();
    throw new LlmUnavailableError(
      (lastError as Error)?.message ?? 'LLM failed',
      this.config.LLM_MAX_ATTEMPTS,
    );
  }

  /**
   * Aborts the underlying HTTP request on timeout rather than merely giving up
   * on the promise — otherwise a hung provider would keep a socket and its
   * worker slot occupied long after we stopped caring about the answer.
   */
  private async callWithDeadline(request: CompletionRequest): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.LLM_TIMEOUT_MS);
    try {
      return await this.provider.complete(request, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`LLM call timed out after ${this.config.LLM_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
