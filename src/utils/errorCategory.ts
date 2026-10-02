/** Never include provider/driver messages, stacks or connection strings in worker diagnostics. */
export function errorCategory(error: unknown): { category: string; code?: string } {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return {
    category: error instanceof Error ? error.name : 'UnknownError',
    ...(typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? { code } : {}),
  };
}
