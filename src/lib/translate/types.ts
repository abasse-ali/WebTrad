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
    /** Nothing more can work until the user acts (key, model, daily quota): the chapter stops. */
    readonly fatal = false,
  ) {
    super(message);
    this.name = 'TranslateError';
  }
}
