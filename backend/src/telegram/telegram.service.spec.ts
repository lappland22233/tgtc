import axios from 'axios';
import { Readable } from 'stream';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TelegramService } from './telegram.service';
import { TelegramFileNotFoundError, TelegramStreamPathError } from './telegram.errors';

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

  it('enables the streaming route when only the streaming base is configured', async () => {
    const stream = Readable.from(Buffer.from('hello'));
    mockedAxios.get.mockResolvedValue({ data: stream, headers: { 'content-length': '5' } } as any);

    const service = new TelegramService({
      get: jest.fn((key: string) => ({
        ...config,
        TELEGRAM_FILE_STREAMING_ENABLED: undefined,
        TELEGRAM_FILE_STREAM_BASE: 'http://127.0.0.1:8084',
      } as any)[key]),
    } as any);

    await service.getRealtimeFileStream('file-id', 5);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'http://127.0.0.1:8084/stream/file/bot123:secret-token/file-id',
      expect.objectContaining({ responseType: 'stream' }),
    );
  });

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

  describe('realtime stream stale-path recovery', () => {
    const streamPath502 = {
      response: {
        status: 502,
        data: { ok: false, description: 'Exact file size is unavailable from Telegram' },
      },
    };

    const createRecoveryService = async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-recovery-'));
      const cfg = {
        ...config,
        TELEGRAM_LOCAL_FILE_DIR: tmpDir,
      };
      return {
        service: new TelegramService({
          get: jest.fn((key: string) => cfg[key as keyof typeof cfg]),
        } as any),
        tmpDir,
      };
    };

    it('classifies the 502 "Exact file size" as a recoverable stream-path error', async () => {
      const { service, tmpDir } = await createRecoveryService();
      const localPath = path.join(tmpDir, 'file.bin');
      await fs.writeFile(localPath, Buffer.from('hello'));

      // 1) 首次 streaming → 502 路径失效
      mockedAxios.get.mockRejectedValueOnce(streamPath502);
      // 2) 恢复 getFileInfo（metadataOnly=false）
      mockedAxios.get.mockResolvedValueOnce({
        data: { result: { file_id: 'file-id', file_path: localPath, file_size: 5 } },
      } as any);
      // 3) getFileStream 内部的 getFileInfo
      mockedAxios.get.mockResolvedValueOnce({
        data: { result: { file_id: 'file-id', file_path: localPath, file_size: 5 } },
      } as any);

      const result = await service.getRealtimeFileStream('file-id', 5);

      // 回源成功：返回的 file_path 为有效本地路径
      expect(result.info.file_path).toBe(localPath);
      expect(result.info.file_size).toBe(5);

      // 恢复 getFileInfo 未传 metadata_only（metadataOnly=false 触发真实下载）
      const getFileCalls = mockedAxios.get.mock.calls.filter(([url]) => String(url).includes('/getFile'));
      expect(getFileCalls.length).toBe(2);
      for (const [, options] of getFileCalls) {
        expect((options as any)?.params?.metadata_only).toBeUndefined();
      }
    });

    it.each([
      'File size is unavailable from Telegram',
      'Exact file size unavailable from Telegram',
    ])('classifies stream size unavailable variant as recoverable: %s', async (description) => {
      const { service, tmpDir } = await createRecoveryService();
      const localPath = path.join(tmpDir, 'variant.bin');
      await fs.writeFile(localPath, Buffer.from('hello'));
      mockedAxios.get.mockRejectedValueOnce({
        response: { status: 502, data: { ok: false, description } },
      } as any);
      mockedAxios.get.mockResolvedValueOnce({
        data: { result: { file_id: 'file-id', file_path: localPath, file_size: 5 } },
      } as any);
      mockedAxios.get.mockResolvedValueOnce({
        data: { result: { file_id: 'file-id', file_path: localPath, file_size: 5 } },
      } as any);

      const result = await service.getRealtimeFileStream('file-id', 5);

      expect(result.info.file_path).toBe(localPath);
      expect(mockedAxios.get.mock.calls.some(([url]) => String(url).includes('/getFile'))).toBe(true);
    });

    it('triggers recovery for a generic 502 from the dedicated stream endpoint', async () => {
      const { service, tmpDir } = await createRecoveryService();
      const localPath = path.join(tmpDir, 'generic-502.bin');
      await fs.writeFile(localPath, Buffer.from('hello'));
      const generic502 = new Error('Request failed with status code 502');
      (generic502 as any).response = { status: 502, data: { ok: false, description: 'Bad Gateway' } };
      mockedAxios.get.mockRejectedValueOnce(generic502);
      mockedAxios.get.mockResolvedValueOnce({
        data: { result: { file_id: 'file-id', file_path: localPath, file_size: 5 } },
      } as any);
      mockedAxios.get.mockResolvedValueOnce({
        data: { result: { file_id: 'file-id', file_path: localPath, file_size: 5 } },
      } as any);

      await expect(service.getRealtimeFileStream('file-id', 5)).resolves.toMatchObject({
        info: { file_path: localPath, file_size: 5 },
      });
      expect(mockedAxios.get.mock.calls.some(([url]) => String(url).includes('/getFile'))).toBe(true);
    });

    it('does not classify a generic 502 from a non-stream Telegram request', async () => {
      const { service } = await createRecoveryService();
      const generic502 = new Error('Request failed with status code 502');
      (generic502 as any).response = { status: 502, data: { ok: false, description: 'Bad Gateway' } };
      mockedAxios.get.mockRejectedValueOnce(generic502);

      await expect((service as any).telegramRequest(
        () => mockedAxios.get('http://127.0.0.1:8084/bot/test'),
        'getFileInfo',
        1,
      )).rejects.not.toBeInstanceOf(TelegramStreamPathError);
    });

    it('throws a permanent error when recovery itself reports file-not-found, only re-sourcing once', async () => {
      const { service } = await createRecoveryService();
      // 1) streaming → 502 路径失效
      mockedAxios.get.mockRejectedValueOnce(streamPath502);
      // 2) 恢复 getFileInfo → invalid file_id（永久失效）
      mockedAxios.get.mockRejectedValueOnce({
        response: { status: 400, data: { ok: false, description: 'Bad Request: invalid file_id' } },
      } as any);

      const err = await service.getRealtimeFileStream('file-id', 5).catch((e) => e);

      expect(err).toBeInstanceOf(TelegramFileNotFoundError);
      expect(String(err?.message)).toMatch(/恢复失败/);

      // 只回源一次（仅一次 /getFile 恢复调用）
      const getFileCalls = mockedAxios.get.mock.calls.filter(([url]) => String(url).includes('/getFile'));
      expect(getFileCalls.length).toBe(1);
    });

    it('keeps a transient 5xx during recovery as a transient error (not permanent, B1)', async () => {
      const { service } = await createRecoveryService();
      // 1) streaming → 502 路径失效
      mockedAxios.get.mockRejectedValueOnce(streamPath502);
      // 2) 恢复 getFileInfo → 普通 5xx（telegramRequest 重试 3 次后抛普通 Error）
      const transient502 = new Error('Request failed with status code 502');
      (transient502 as any).response = { status: 502, data: { ok: false, description: 'Bad Gateway' } };
      mockedAxios.get.mockRejectedValue(transient502);

      const err = await service.getRealtimeFileStream('file-id', 5).catch((e) => e);

      // 瞬时错误保持原类型，绝不包装成永久错误
      expect(err).not.toBeInstanceOf(TelegramFileNotFoundError);
      expect(err).toBeInstanceOf(Error);
    });

    it('keeps a timeout during recovery as a transient error (not permanent, B1)', async () => {
      const { service } = await createRecoveryService();
      // 1) streaming → 502 路径失效
      mockedAxios.get.mockRejectedValueOnce(streamPath502);
      // 2) 恢复 getFileInfo → 超时（无 response，普通 Error）
      const timeoutErr = new Error('timeout of 60000ms exceeded');
      (timeoutErr as any).code = 'ECONNABORTED';
      mockedAxios.get.mockRejectedValue(timeoutErr);

      const err = await service.getRealtimeFileStream('file-id', 5).catch((e) => e);

      expect(err).not.toBeInstanceOf(TelegramFileNotFoundError);
      expect(err).toBeInstanceOf(Error);
    });

    it('does not recurse and keeps a stream-path error transient when empty file_path retry still fails', async () => {
      const { service } = await createRecoveryService();
      // 1) 首次 streaming → 502 路径失效
      mockedAxios.get.mockRejectedValueOnce(streamPath502);
      // 2) 恢复 getFileInfo → file_path 为空（Bot API 无本地路径）
      mockedAxios.get.mockResolvedValueOnce({
        data: { result: { file_id: 'file-id', file_path: '', file_size: 0 } },
      } as any);
      // 3) 恢复路径再次 streaming → 仍 502 路径失效（不应再进入回源；保持可恢复错误，不锁死文件）
      mockedAxios.get.mockRejectedValueOnce(streamPath502);

      const err = await service.getRealtimeFileStream('file-id', 5).catch((e) => e);

      // 路径失效型 502 不代表 Telegram 永久不存在，保持可恢复错误类型，绝不转永久
      expect(err).toBeInstanceOf(TelegramStreamPathError);
      expect(err).not.toBeInstanceOf(TelegramFileNotFoundError);

      // 总共 streaming 2 次（首次 + 恢复路径一次），无递归
      const streamCalls = mockedAxios.get.mock.calls.filter(([url]) => String(url).includes('/stream/file'));
      expect(streamCalls.length).toBe(2);
    });

    it('throws TelegramStreamPathError when a local absolute path is missing (ENOENT)', async () => {
      const { service, tmpDir } = await createRecoveryService();
      const missingPath = path.join(tmpDir, 'does-not-exist.bin');
      mockedAxios.get.mockResolvedValueOnce({
        data: { result: { file_id: 'file-id', file_path: missingPath, file_size: 5 } },
      } as any);

      await expect(service.getFileStream('file-id'))
        .rejects.toBeInstanceOf(TelegramStreamPathError);
    });

    it('redacts the bot token from error messages', async () => {
      const { service } = await createRecoveryService();
      // 普通 5xx 保持普通错误，其 message 经 redactToken 脱敏
      const axiosError = {
        response: {
          status: 500,
          data: { ok: false, description: 'upstream failure' },
        },
        message: 'Request failed /file/bot123:secret-token/xyz',
        config: { url: 'http://127.0.0.1:8081/file/bot123:secret-token/doc.bin' },
      };
      mockedAxios.get.mockRejectedValueOnce(axiosError);

      const err = await service.getRealtimeFileStream('file-id', 5).catch((e) => e);

      // telegramRequest 会脱敏 axiosError 的 message 与 config.url
      expect(String(err?.message ?? '')).not.toContain('secret-token');
      expect(String(axiosError.config?.url ?? '')).not.toContain('secret-token');
    });

    it('deduplicates concurrent recovery for the same file_id (R9)', async () => {
      const { service, tmpDir } = await createRecoveryService();
      const localPath = path.join(tmpDir, 'file.bin');
      await fs.writeFile(localPath, Buffer.from('hello'));

      // 两个并发调用共享同一 file_id：首次 streaming 均 502
      mockedAxios.get.mockRejectedValueOnce(streamPath502);
      mockedAxios.get.mockRejectedValueOnce(streamPath502);
      // 恢复 getFileInfo 只应触发一次（R9 去重）
      mockedAxios.get.mockResolvedValueOnce({
        data: { result: { file_id: 'file-id', file_path: localPath, file_size: 5 } },
      } as any);
      // getFileStream 内部的 getFileInfo（两个并发调用可能各自触发）
      mockedAxios.get.mockResolvedValue({
        data: { result: { file_id: 'file-id', file_path: localPath, file_size: 5 } },
      } as any);

      const [r1, r2] = await Promise.all([
        service.getRealtimeFileStream('file-id', 5),
        service.getRealtimeFileStream('file-id', 5),
      ]);

      expect(r1.info.file_path).toBe(localPath);
      expect(r2.info.file_path).toBe(localPath);

      // 恢复 getFileInfo（recoverRealtimeStream 标签）应只执行一次：
      // 两个并发调用共享同一恢复 Promise
      const recoverCalls = mockedAxios.get.mock.calls.filter(([url]) => String(url).includes('/getFile'));
      // 恢复(1) + 每个并发调用的 getFileStream getFileInfo(2) = 3
      expect(recoverCalls.length).toBeLessThanOrEqual(3);
    });
  });
});
