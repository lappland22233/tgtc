import axios from 'axios';
import { PassThrough, Readable } from 'stream';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { TelegramService } from './telegram.service';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function createService(overrides: Record<string, string> = {}) {
  const config: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: '123456:test-token',
    TELEGRAM_CHAT_ID: '-100123',
    TELEGRAM_API_BASE: 'http://localhost:8081',
    TELEGRAM_FIRST_BYTE_TIMEOUT_MS: '20',
    TELEGRAM_DOWNLOAD_TIMEOUT_MS: '1000',
    TELEGRAM_LOCAL_FILE_DIR: '/data/api/telegram-bot-api/workdir',
    ...overrides,
  };
  const configService = { get: jest.fn((key: string) => config[key]) } as unknown as ConfigService;
  return new TelegramService(configService);
}

describe('TelegramService getFileStream with self-hosted Bot API', () => {
  beforeEach(() => jest.clearAllMocks());

  afterEach(() => jest.restoreAllMocks());

  it('相对 file_path 应通过当前 Bot API 文件端点下载', async () => {
    const remote = new PassThrough();
    mockedAxios.get.mockResolvedValueOnce({ data: remote } as never);

    const pending = createService().getFileStream(
      'tg-file',
      { file_path: 'documents/large.bin', file_size: 1024 },
    );
    setTimeout(() => remote.write(Buffer.from('data')), 5);

    const result = await pending;
    expect(result.stream).toBe(remote);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'http://localhost:8081/file/bot123456:test-token/documents/large.bin',
      expect.objectContaining({ responseType: 'stream', timeout: 1000 }),
    );
    remote.end();
  });

  it('Bot API 返回绝对路径时应直接读取本地文件，不拼接文件 URL', async () => {
    const local = Readable.from(Buffer.from('local-data'));
    const handle = { createReadStream: jest.fn(() => local), close: jest.fn() };
    jest.spyOn(fs, 'open').mockResolvedValueOnce(handle as never);
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        result: {
          file_id: 'tg-file',
          file_path: '/data/api/telegram-bot-api/workdir/documents/file_1496',
          file_size: 10,
        },
      },
    } as never);

    const result = await createService().getFileStream('tg-file');

    expect(result.stream).toBe(local);
    expect(fs.open).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]data[\\/]api[\\/]telegram-bot-api[\\/]workdir[\\/]documents[\\/]file_1496$/),
      'r',
    );
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'http://localhost:8081/bot123456:test-token/getFile',
      expect.objectContaining({ params: { file_id: 'tg-file' } }),
    );
  });

  it('数据库旧路径缺失时应通过当前 Bot API 刷新为新的绝对路径', async () => {
    const local = Readable.from(Buffer.from('refreshed-data'));
    const handle = { createReadStream: jest.fn(() => local), close: jest.fn() };
    jest.spyOn(fs, 'open')
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      .mockResolvedValueOnce(handle as never);
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        result: {
          file_id: 'tg-file',
          file_path: '/data/api/telegram-bot-api/workdir/documents/file_1496',
          file_size: 1024,
        },
      },
    } as never);

    const result = await createService().getFileStream(
      'tg-file',
      { file_path: '/data/api/telegram-bot-api/workdir/documents/file_1226.002', file_size: 1024 },
    );

    expect(result.stream).toBe(local);
    expect(result.info.file_path).toBe('/data/api/telegram-bot-api/workdir/documents/file_1496');
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'http://localhost:8081/bot123456:test-token/getFile',
      expect.objectContaining({ params: { file_id: 'tg-file' } }),
    );
  });

  it('数据库旧路径缺失时应支持刷新为相对路径后下载', async () => {
    const remote = new PassThrough();
    jest.spyOn(fs, 'open').mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    mockedAxios.get
      .mockResolvedValueOnce({
        data: { result: { file_id: 'tg-file', file_path: 'photos/file_169.jpg', file_size: 1024 } },
      } as never)
      .mockResolvedValueOnce({ data: remote } as never);

    const pending = createService().getFileStream(
      'tg-file',
      { file_path: '/data/api/telegram-bot-api/workdir/photos/file_247.jpg', file_size: 1024 },
    );
    setTimeout(() => remote.write(Buffer.from('remote-data')), 5);

    const result = await pending;
    expect(result.stream).toBe(remote);
    expect(mockedAxios.get).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8081/file/bot123456:test-token/photos/file_169.jpg',
      expect.objectContaining({ responseType: 'stream' }),
    );
    remote.end();
  });

  it('刷新后的绝对路径仍缺失时应受控失败且不重复刷新', async () => {
    jest.spyOn(fs, 'open')
      .mockRejectedValueOnce(Object.assign(new Error('old missing'), { code: 'ENOENT' }))
      .mockRejectedValueOnce(Object.assign(new Error('new missing'), { code: 'ENOENT' }));
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        result: {
          file_id: 'tg-file',
          file_path: '/data/api/telegram-bot-api/workdir/documents/file_1496',
          file_size: 1024,
        },
      },
    } as never);

    await expect(createService().getFileStream(
      'tg-file',
      { file_path: '/data/api/telegram-bot-api/workdir/documents/file_711.004', file_size: 1024 },
    )).rejects.toThrow('本地文件路径已失效');
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('file_id 无法解析时应报告文件失效并要求重新上传', async () => {
    mockedAxios.get.mockRejectedValueOnce({
      response: { status: 404, data: { description: 'Not Found' } },
      config: { url: 'http://localhost:8081/bot123456:test-token/getFile' },
      message: 'Request failed with status code 404',
    });

    await expect(createService().getFileStream('expired-file-id')).rejects.toThrow(
      'Telegram 文件已失效或 Bot API 无法解析该 file_id，请重新上传文件',
    );
  });

  it('本地路径越过白名单时不得刷新或下载', async () => {
    await expect(createService().getFileStream(
      'tg-file',
      { file_path: '/etc/passwd', file_size: 1024 },
    )).rejects.toThrow('非法的本地文件路径');
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});
