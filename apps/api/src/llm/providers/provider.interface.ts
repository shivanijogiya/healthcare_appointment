export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(request: CompletionRequest, signal: AbortSignal): Promise<string>;
}

/** Thrown for 4xx-class problems where retrying the same request is pointless. */
export class NonRetryableLlmError extends Error {
  readonly nonRetryable = true;
}
