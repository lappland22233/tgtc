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
  it('disables redirects for multipart uploads', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { result: { document: { file_id: 'f' } } } });
    const client = new TelegramAccountClientService({ get: () => undefined } as any);
    await client.sendDocumentStream('a', '1:test', 'chat', Readable.from(['x']), 'a', 1);
    expect(post.mock.calls[0][2]).toEqual(expect.objectContaining({ maxRedirects: 0 }));
  });
});
