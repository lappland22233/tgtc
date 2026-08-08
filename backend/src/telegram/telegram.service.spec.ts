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

    const result = await createService().getRealtimeFileStream('a+b/c=', 5);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'http://127.0.0.1:8081/stream/file/bot123:secret-token/a%2Bb%2Fc%3D',
      expect.objectContaining({
        responseType: 'stream',
        timeout: 30000,
        maxRedirects: 0,
        headers: { 'X-Telegram-File-Size': '5' },
      }),
    );
    expect(result.info.file_size).toBe(5);
  });

  it('rejects a response without a valid Content-Length', async () => {
    const stream = Readable.from(Buffer.from('hello'));
    mockedAxios.get.mockResolvedValue({ data: stream, headers: {} } as any);

    await expect(createService().getRealtimeFileStream('file-id', 5)).rejects.toThrow('Content-Length');
    expect(stream.destroyed).toBe(true);
  });

  it('rejects and destroys a stream when Content-Length conflicts with expected size', async () => {
    const stream = Readable.from(Buffer.from('hello'));
    mockedAxios.get.mockResolvedValue({ data: stream, headers: { 'content-length': '4' } } as any);

    await expect(createService().getRealtimeFileStream('file-id', 5)).rejects.toThrow('文件大小不一致');
    expect(stream.destroyed).toBe(true);
  });

  it('rejects an invalid expected size before sending a request', async () => {
    await expect(createService().getRealtimeFileStream('file-id', 0)).rejects.toThrow('预期文件大小');
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('keeps legacy callers compatible when no size hint is provided', async () => {
    const stream = Readable.from(Buffer.from('hello'));
    mockedAxios.get.mockResolvedValue({ data: stream, headers: { 'content-length': '5' } } as any);

    await createService().getRealtimeFileStream('file-id');
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: undefined }),
    );
  });

  it('attaches X-Telegram-No-Cache header together with the size hint on no-cache passthrough', async () => {
    const stream = Readable.from(Buffer.from('hello'));
    mockedAxios.get.mockResolvedValue({ data: stream, headers: { 'content-length': '5' } } as any);

    await createService().getRealtimeFileStream('file-id', 5, { noCache: true });
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { 'X-Telegram-File-Size': '5', 'X-Telegram-No-Cache': '1' },
      }),
    );
  });

  it('attaches X-Telegram-No-Cache header alone when no size hint is provided', async () => {
    const stream = Readable.from(Buffer.from('hello'));
    mockedAxios.get.mockResolvedValue({ data: stream, headers: { 'content-length': '5' } } as any);

    await createService().getRealtimeFileStream('file-id', undefined, { noCache: true });
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { 'X-Telegram-No-Cache': '1' } }),
    );
  });

  describe('uploadFile media response compatibility', () => {
    const mockFileInfo = (expectedFileId: string) => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { result: { file_id: expectedFileId, file_path: 'documents/file.bin', file_size: 4 } },
      } as any);
    };

    it('uses document.file_id for normal files', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { ok: true, result: { document: { file_id: 'document-id' } } },
      } as any);
      mockFileInfo('document-id');

      const result = await createService().uploadFile(Buffer.from('test'), 'test.bin');

      expect(result.file_id).toBe('document-id');
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/getFile'),
        expect.objectContaining({ params: { file_id: 'document-id' } }),
      );
    });

    it('falls back to animation.file_id for short MP4 responses', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { ok: true, result: { animation: { file_id: 'animation-id' } } },
      } as any);
      mockFileInfo('animation-id');

      const result = await createService().uploadFile(Buffer.from('test'), 'short.mp4');

      expect(result.file_id).toBe('animation-id');
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/getFile'),
        expect.objectContaining({ params: { file_id: 'animation-id' } }),
      );
    });

    it('falls back to video.file_id for MP4 video responses', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { ok: true, result: { video: { file_id: 'video-id' } } },
      } as any);
      mockFileInfo('video-id');

      const result = await createService().uploadFile(Buffer.from('test'), 'video.mp4');

      expect(result.file_id).toBe('video-id');
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/getFile'),
        expect.objectContaining({ params: { file_id: 'video-id' } }),
      );
    });

    it('prefers document.file_id when multiple media fields exist', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          ok: true,
          result: {
            document: { file_id: 'document-id' },
            animation: { file_id: 'animation-id' },
          },
        },
      } as any);
      mockFileInfo('document-id');

      const result = await createService().uploadFile(Buffer.from('test'), 'mixed.mp4');

      expect(result.file_id).toBe('document-id');
    });

    it('reports an invalid response without blaming the file format', async () => {
      mockedAxios.post.mockResolvedValue({ data: { ok: true, result: {} } } as any);

      await expect(createService().uploadFile(Buffer.from('test'), 'unknown.bin'))
        .rejects.toThrow('响应缺少可识别的媒体 file_id');
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });
  });
});
