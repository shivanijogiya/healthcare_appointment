import { LlmProvider } from './provider.interface';

/** Failure-injection provider: proves the system degrades instead of breaking. */
export class FailingProvider implements LlmProvider {
  readonly name = 'failing';
  readonly model = 'failing';

  async complete(): Promise<string> {
    throw new Error('Injected LLM failure');
  }
}
