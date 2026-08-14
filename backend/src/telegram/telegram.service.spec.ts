import axios from 'axios';
import { Readable } from 'stream';
import { TelegramService } from './telegram.service';
import { TelegramFileNotFoundError } from './telegram.errors';

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

    it('falls back to audio.file_id for MP3/audio responses', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { ok: true, result: { audio: { file_id: 'audio-id' } } },
      } as any);
      mockFileInfo('audio-id');

      const result = await createService().uploadFile(Buffer.from('test'), 'song.mp3');

      expect(result.file_id).toBe('audio-id');
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/getFile'),
        expect.objectContaining({ params: { file_id: 'audio-id' } }),
      );
    });

    it('falls back to voice.file_id for voice responses', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { ok: true, result: { voice: { file_id: 'voice-id' } } },
      } as any);
      mockFileInfo('voice-id');

      const result = await createService().uploadFile(Buffer.from('test'), 'memo.ogg');

      expect(result.file_id).toBe('voice-id');
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/getFile'),
        expect.objectContaining({ params: { file_id: 'voice-id' } }),
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

  describe('telegramRequest 400 error fidelity', () => {
    it('preserves the Telegram description for a generic 400 error', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 400, data: { ok: false, description: 'bad request: something wrong' } },
      } as any);

      await expect(createService().uploadFile(Buffer.from('test'), 'test.bin'))
        .rejects.toThrow('bad request: something wrong');
    });

    it('sanitizes control characters, collapses whitespace and caps the length', async () => {
      const long = 'x'.repeat(2000);
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 400, data: { ok: false, description: `A\r\n\tB  ${long}` } },
      } as any);

      await expect(createService().uploadFile(Buffer.from('test'), 'test.bin'))
        .rejects.toThrow('A B');
    });

    it('falls back to a stable message when the description is missing', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 400, data: { ok: false } },
      } as any);

      await expect(createService().uploadFile(Buffer.from('test'), 'test.bin'))
        .rejects.toThrow('请求参数错误');
    });

    it('keeps known 400 mappings for image and chat errors', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 400, data: { ok: false, description: 'IMAGE_PROCESS_FAILED' } },
      } as any);
      await expect(createService().uploadFile(Buffer.from('test'), 'bad.png'))
        .rejects.toThrow('图片处理失败');

      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 400, data: { ok: false, description: 'chat not found' } },
      } as any);
      await expect(createService().uploadFile(Buffer.from('test'), 'test.bin'))
        .rejects.toThrow('群组未找到');
    });
  });

  describe('TelegramFileNotFoundError classification', () => {
    it('maps 400 invalid file_id to TelegramFileNotFoundError', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 400, data: { ok: false, description: 'Bad Request: invalid file_id' } },
      } as any);

      const err = await createService().uploadFile(Buffer.from('test'), 'test.bin').catch((e) => e);
      expect(err).toBeInstanceOf(TelegramFileNotFoundError);
      expect(String(err?.message)).toMatch(/invalid file_id/i);
    });

    it('maps 404 file not found to TelegramFileNotFoundError', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 404, data: { ok: false, description: 'file not found' } },
      } as any);

      const err = await createService().uploadFile(Buffer.from('test'), 'test.bin').catch((e) => e);
      expect(err).toBeInstanceOf(TelegramFileNotFoundError);
    });

    it('keeps 404 without resource description as a plain bot-not-found error', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 404, data: { ok: false } },
      } as any);

      await expect(createService().uploadFile(Buffer.from('test'), 'test.bin'))
        .rejects.toThrow('Telegram Bot 未找到');
    });

    it('does not classify transient errors as file-not-found', async () => {
      // 429 限流：不识别为文件失效
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 429, data: { ok: false, parameters: { retry_after: 1 } } },
      } as any);
      await expect(createService().uploadFile(Buffer.from('test'), 'test.bin'))
        .rejects.not.toBeInstanceOf(TelegramFileNotFoundError);

      // 5xx 服务端错误：不识别为文件失效
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 500, data: { ok: false, description: 'internal error' } },
      } as any);
      await expect(createService().uploadFile(Buffer.from('test'), 'test.bin'))
        .rejects.not.toBeInstanceOf(TelegramFileNotFoundError);
    });

    it('exposes metadata without preloading file content and rejects stale file_id', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { ok: true, result: { file_id: 'fresh-id', file_size: 42 } },
      } as any);
      const meta = await createService().verifyFileExists('fresh-id');
      expect(meta).toEqual({ file_id: 'fresh-id', file_path: '', file_size: 42 });
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/getFile'),
        expect.objectContaining({
          params: { file_id: 'fresh-id', metadata_only: true },
          timeout: 15 * 1000,
        }),
      );
      expect(String(mockedAxios.get.mock.calls[0][0])).not.toContain('/file/bot');

      mockedAxios.get.mockRejectedValueOnce({
        response: { status: 400, data: { ok: false, description: 'Bad Request: invalid file_id' } },
      } as any);
      await expect(createService().verifyFileExists('stale-id'))
        .rejects.toBeInstanceOf(TelegramFileNotFoundError);
    });

    it('rejects an empty or oversized file_id before hitting the network', async () => {
      const service = createService();
      await expect(service.verifyFileExists('')).rejects.toBeInstanceOf(TelegramFileNotFoundError);
      await expect(service.verifyFileExists('x'.repeat(5000))).rejects.toBeInstanceOf(TelegramFileNotFoundError);
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });
  });
});
