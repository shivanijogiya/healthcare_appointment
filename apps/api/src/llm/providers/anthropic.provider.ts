import { CompletionRequest, LlmProvider, NonRetryableLlmError } from './provider.interface';

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.anthropic.com',
  ) {}

  async complete(request: CompletionRequest, signal: AbortSignal): Promise<string> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new NonRetryableLlmError(`Anthropic ${response.status}: ${body.slice(0, 300)}`);
      }
      throw new Error(`Anthropic ${response.status}: ${body.slice(0, 300)}`);
    }

    const data: any = await response.json();
    const text = (data.content ?? [])
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('\n')
      .trim();
    if (!text) throw new Error('Anthropic returned an empty completion.');
    return text;
  }
}
