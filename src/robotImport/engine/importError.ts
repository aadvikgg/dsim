/**
 * The importer's one error type, three-free so the import worker can throw it and the main thread
 * re-throw it from the worker's message with the same code and sentence.
 */
export type ImportErrorCode = 'no-file' | 'unsupported' | 'too-large' | 'corrupt' | 'empty' | 'missing-file' | 'draco' | 'step-failed';

/** a load failure with a sentence the UI can show as is (copy: docs/area/ui.md) */
export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

/** the error a cancelled import rejects with (`err.name === 'AbortError'`) */
export function abortError(): Error {
  const e = new Error('The import was cancelled.');
  e.name = 'AbortError';
  return e;
}
