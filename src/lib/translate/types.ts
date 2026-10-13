export interface TranslateRequest {
  texts: string[];
  source: string;
  target: string;
  signal?: AbortSignal;
}

export interface TranslationEngine {
  id: string;
  translate(req: TranslateRequest): Promise<string[]>;
}

export class TranslateError extends Error {
  constructor(
    message: string,
    readonly engine: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'TranslateError';
  }
}
