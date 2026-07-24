import axios from 'axios';
import { PassThrough } from 'stream';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from './telegram.service';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function createService(overrides: Record<string, string> = {}) {
  const config: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: '123456:test-token',
    TELEGRAM_CHAT_ID: '-100123',
    TELEGRAM_API_BASE: 'https://api.telegram.org',
    TELEGRAM_RELAY_BASE: 'https://relay.example.com',
    TELEGRAM_RELAY_MIN_FILE_SIZE: '100',
    TELEGRAM_DIRECT_FIRST_BYTE_TIMEOUT_MS: '20',
    TELEGRAM_RELAY_FIRST_BYTE_TIMEOUT_MS: '50',
    TELEGRAM_DOWNLOAD_TIMEOUT_MS: '1000',
    ...overrides,
  };
  const configService = { get: jest.fn((key: string) => config[key]) } as unknown as ConfigService;
  return new TelegramService(configService);
}

describe('TelegramService getFileStream relay fallback', () => {
  beforeEach(() => jest.clearAllMocks());

  it('大型文件直连首字节超时后应切换中转', async () => {
    const direct = new PassThrough();
    const relay = new PassThrough();
    mockedAxios.get
      .mockResolvedValueOnce({ data: direct } as never)
      .mockResolvedValueOnce({ data: relay } as never);

    const pending = createService().getFileStream(
      'tg-file',
      { file_path: 'documents/large.bin', file_size: 1024 },
    );
    setTimeout(() => relay.write(Buffer.from('relay-data')), 30);

    const result = await pending;
    expect(result.stream).toBe(relay);
    expect(direct.destroyed).toBe(true);
    expect(mockedAxios.get).toHaveBeenNthCalledWith(
      2,
      'https://relay.example.com/file/bot123456:test-token/documents/large.bin',
      expect.objectContaining({ responseType: 'stream', timeout: 1000 }),
    );
    relay.end();
  });

  it('小文件直连失败时不应触发中转', async () => {
    const direct = new PassThrough();
    mockedAxios.get.mockResolvedValueOnce({ data: direct } as never);

    await expect(createService().getFileStream(
      'tg-file',
      { file_path: 'documents/small.bin', file_size: 50 },
    )).rejects.toThrow('首字节超时');
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('直连及时返回首字节时应保持直连', async () => {
    const direct = new PassThrough();
    mockedAxios.get.mockResolvedValueOnce({ data: direct } as never);

    const pending = createService().getFileStream(
      'tg-file',
      { file_path: 'documents/large.bin', file_size: 1024 },
    );
    setTimeout(() => direct.write(Buffer.from('direct-data')), 5);

    const result = await pending;
    expect(result.stream).toBe(direct);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    direct.end();
  });
});
