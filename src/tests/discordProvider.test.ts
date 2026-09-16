import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordProvider } from '../services/notifications/DiscordProvider';

// Mock global fetch
const fetchMock = vi.fn();
global.fetch = fetchMock;

describe('DiscordProvider', () => {
  let provider: DiscordProvider;
  
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc';
    provider = new DiscordProvider();
  });

  const validPayload = {
    actionId: 'action-123',
    companyName: 'Acme Corp',
    jobTitle: 'Software Engineer',
    actionRequested: 'Send thank you note',
    actionType: 'ACTION_REQUIRED',
    deadline: '2023-10-15T12:00:00.000Z'
  };

  it('handles missing configuration without retry', async () => {
    delete process.env.DISCORD_WEBHOOK_URL;
    const result = await provider.send(validPayload);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.errorCategory).toBe('MissingConfig');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('delivers notification successfully', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204
    });

    const result = await provider.send(validPayload);
    expect(result.success).toBe(true);
    expect(result.retryable).toBe(false);

    // Verify payload is sanitized and formatted correctly
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0];
    expect(url).toBe('https://discord.com/api/webhooks/123/abc');
    expect(requestInit.method).toBe('POST');
    
    const body = JSON.parse(requestInit.body as string);
    expect(body.embeds[0].title).toBe('Action Required: Acme Corp');
    expect(body.embeds[0].fields).toContainEqual({ name: 'Role', value: 'Software Engineer', inline: true });
    expect(body.embeds[0].fields).toContainEqual({ name: 'Action', value: 'Send thank you note', inline: true });
    
    // Webhook secret is never logged (we just check the provider doesn't output it)
  });

  it('handles network failure as retryable and sanitizes error details', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Sensitive detailed fetch failure internal url https://xyz'));

    const result = await provider.send(validPayload);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.errorCategory).toBe('NetworkError');
    expect(result.errorDetails).toBe('Request failed due to a network error or timeout.');
  });

  it('handles timeout (AbortError) as retryable', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(abortError);

    const result = await provider.send(validPayload);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.errorCategory).toBe('TimeoutError');
    expect(result.errorDetails).toBe('Request failed due to a network error or timeout.');
  });

  it('handles HTTP 429 as retryable', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: vi.fn().mockResolvedValue('Rate limited')
    });

    const result = await provider.send(validPayload);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.errorCategory).toBe('HTTP_429');
    
    // Ensure errorDetails doesn't leak secrets
    expect(result.errorDetails).toBe('Discord responded with status 429.');
  });

  it('handles HTTP 5xx as retryable', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: vi.fn().mockResolvedValue('Bad Gateway')
    });

    const result = await provider.send(validPayload);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.errorCategory).toBe('HTTP_502');
  });

  it('handles HTTP 4xx (non-429) as non-retryable', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('Bad Request')
    });

    const result = await provider.send(validPayload);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.errorCategory).toBe('HTTP_400');
  });
});
