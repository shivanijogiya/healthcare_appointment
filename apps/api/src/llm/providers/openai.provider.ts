import { CompletionRequest, LlmProvider, NonRetryableLlmError } from './provider.interface';

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.openai.com',
  ) {}

  async complete(request: CompletionRequest, signal: AbortSignal): Promise<string> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        temperature: request.temperature ?? 0,
        max_tokens: request.maxTokens ?? 1024,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new NonRetryableLlmError(`OpenAI ${response.status}: ${body.slice(0, 300)}`);
      }
      throw new Error(`OpenAI ${response.status}: ${body.slice(0, 300)}`);
    }

    const data: any = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('OpenAI returned an empty completion.');
    return text;
  }
}
