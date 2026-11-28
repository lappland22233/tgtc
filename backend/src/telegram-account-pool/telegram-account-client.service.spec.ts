import axios from 'axios';
import { PassThrough, Readable } from 'stream';
import { TelegramAccountClientService } from './telegram-account-client.service';

describe('Telegram account transfer streams', () => {
  afterEach(() => jest.restoreAllMocks());
  it('preserves bytes when the consumer attaches after upstream starts', async () => {
    const upstream = new PassThrough();
    jest.spyOn(axios, 'get').mockResolvedValue({ data: upstream, headers: { 'content-length': '6' } });
    const client = new TelegramAccountClientService({ get: (key: string) => key === 'TELEGRAM_FILE_STREAMING_ENABLED' ? 'true' : undefined } as any);
    const session = await client.openRealtimeStream('a', '1:test', 'file');
    upstream.end(Buffer.from('abcdef'));
    await new Promise(resolve => setImmediate(resolve));
    const chunks: Buffer[] = [];
    for await (const chunk of session.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('abcdef');
  });
  it('reports the wait from a streaming 429 response and closes the body', async () => {
    const body = Readable.from(['{"parameters":{"retry_after":11}}']);
    jest.spyOn(axios, 'get').mockRejectedValueOnce({ response: { status: 429, data: body } });
    const client = new TelegramAccountClientService({ get: (key: string) => key === 'TELEGRAM_FILE_STREAMING_ENABLED' ? 'true' : undefined } as any);
    await expect(client.openRealtimeStream('a', '1:test', 'file'))
      .rejects.toMatchObject({ kind: 'flood', retryAfterSeconds: 11 });
    expect(body.destroyed).toBe(true);
  });
  it('disables redirects for multipart uploads', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { result: { document: { file_id: 'f' } } } });
    const client = new TelegramAccountClientService({ get: () => undefined } as any);
    await client.sendDocumentStream('a', '1:test', 'chat', Readable.from(['x']), 'a', 1);
    expect(post.mock.calls[0][2]).toEqual(expect.objectContaining({ maxRedirects: 0 }));
  });
  it('serializes allowed_updates as a JSON string in getUpdates', async () => {
    const get = jest.spyOn(axios, 'get').mockResolvedValue({ data: { ok: true, result: [] } });
    const client = new TelegramAccountClientService({ get: () => undefined } as any);
    await client.getUpdates('a', '1:test', 10, 30);
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining('/getUpdates'),
      expect.objectContaining({
        params: expect.objectContaining({
          allowed_updates: JSON.stringify(['message', 'channel_post', 'callback_query']),
        }),
      }),
    );
  });
});
