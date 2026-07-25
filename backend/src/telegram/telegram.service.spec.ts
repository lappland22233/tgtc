import axios from 'axios';
import { Readable } from 'stream';
import { TelegramService } from './telegram.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('TelegramService realtime stream', () => {
  const config = {
    TELEGRAM_BOT_TOKEN: '123:secret-token',
    TELEGRAM_CHAT_ID: '1',
    TELEGRAM_API_BASE: 'http://127.0.0.1:8081',
    TELEGRAM_FILE_STREAMING_ENABLED: 'true',
    TELEGRAM_FILE_STREAM_BASE: 'http://127.0.0.1:8081/',
    TELEGRAM_FILE_STREAM_TIMEOUT_SECONDS: '30',
  };

  const createService = () => new TelegramService({
    get: jest.fn((key: string) => config[key as keyof typeof config]),
  } as any);

  beforeEach(() => jest.clearAllMocks());

  it('uses the independent encoded file_id route and validates length', async () => {
    const stream = Readable.from(Buffer.from('hello'));
    mockedAxios.get.mockResolvedValue({ data: stream, headers: { 'content-length': '5' } } as any);

    const result = await createService().getRealtimeFileStream('a+b/c=');

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'http://127.0.0.1:8081/stream/file/bot123:secret-token/a%2Bb%2Fc%3D',
      expect.objectContaining({ responseType: 'stream', timeout: 30000, maxRedirects: 0 }),
    );
    expect(result.info.file_size).toBe(5);
  });

  it('rejects a response without a valid Content-Length', async () => {
    const stream = Readable.from(Buffer.from('hello'));
    mockedAxios.get.mockResolvedValue({ data: stream, headers: {} } as any);

    await expect(createService().getRealtimeFileStream('file-id')).rejects.toThrow('Content-Length');
    expect(stream.destroyed).toBe(true);
  });
});
