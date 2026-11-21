import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { createClient, type FileStat } from 'webdav';
import { WebDavStorageDriver } from './webdav.driver';
import type { StorageAccountContext } from '../storage.types';

// Jest 29's CJS loader cannot load webdav's ESM distribution. Use Node's native loader
// for this dependency so the actual locked client and its minimatch implementation run.
jest.mock('webdav', () => {
  const loader = process.getBuiltinModule('module') as typeof import('node:module');
  return loader.createRequire(__filename)('webdav');
});

describe('WebDAV 本地 HTTP 协议', () => {
  const contents = new Map<string, Buffer>([
    ['/docs/readme.txt', Buffer.from('lower')],
    ['/docs/UPPER.TXT', Buffer.from('upper')],
    ['/docs/video.bin', Buffer.from('data')],
  ]);
  const folders = new Set(['/docs', '/docs/nested']);
  let server: Server;
  let url: string;
  let putContentLength: string | undefined;

  function propstat(name: string): string {
    const data = contents.get(name);
    return `<d:response><d:href>${name}</d:href><d:propstat><d:prop>
      <d:resourcetype>${folders.has(name) ? '<d:collection/>' : ''}</d:resourcetype>
      <d:getcontentlength>${data?.length ?? 0}</d:getcontentlength>
      </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  }

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const name = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname).replace(/\/$/, '');
      if (req.method === 'PUT') {
        putContentLength = req.headers['content-length'];
        if (putContentLength === undefined) {
          res.writeHead(411).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        contents.set(name, Buffer.concat(chunks));
        res.writeHead(201).end();
        return;
      }
      if (!folders.has(name) && !contents.has(name)) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === 'PROPFIND') {
        const names = req.headers.depth === '1' && name === '/docs'
          ? [...folders, ...contents.keys()] : [name];
        const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${names.map(propstat).join('')}</d:multistatus>`;
        res.writeHead(207, { 'Content-Type': 'application/xml' }).end(xml);
        return;
      }
      if (req.method === 'GET') {
        const data = contents.get(name)!;
        if (req.headers.range === 'bytes=1-3') {
          res.writeHead(206, { 'Content-Range': `bytes 1-3/${data.length}` }).end(data.subarray(1, 4));
        } else {
          res.writeHead(200).end(data);
        }
        return;
      }
      if (req.method === 'DELETE') {
        contents.delete(name);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(405).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
      server.closeAllConnections();
    });
  });

  it('PROPFIND 保留目录类型、以 basename 匹配 glob 并区分扩展名大小写', async () => {
    const client = createClient(url);
    const list = await client.getDirectoryContents('/docs') as FileStat[];
    expect(list.map(({ basename, type }) => [basename, type]).sort()).toEqual([
      ['UPPER.TXT', 'file'], ['nested', 'directory'], ['readme.txt', 'file'], ['video.bin', 'file'],
    ]);
    const filtered = await client.getDirectoryContents('/docs', { glob: '*.txt' }) as FileStat[];
    expect(filtered.map((file) => file.filename)).toEqual(['/docs/readme.txt']);
    const both = await client.getDirectoryContents('/docs', { glob: '*.{txt,TXT}' }) as FileStat[];
    expect(both.map((file) => file.basename).sort()).toEqual(['UPPER.TXT', 'readme.txt']);
  });

  it('通过项目驱动探测目录、上传、读取范围、删除对象', async () => {
    const driver = new WebDavStorageDriver();
    const ctx: StorageAccountContext = {
      type: 'webdav', accountId: 'local', config: { url, rootPath: 'docs' },
      credential: { username: 'fixture', password: 'fixture' },
    };
    expect(await driver.probeAccount(ctx)).toMatchObject({ ok: true });
    const data = Buffer.from('abcdefgh');
    const receipt = await driver.upload(ctx, {
      objectName: 'sample.txt', knownLength: data.length, openStream: () => Readable.from([data]),
    });
    expect(contents.get(receipt.objectRef)).toEqual(data);
    expect(putContentLength).toBe(String(data.length));
    expect(await driver.headObject(ctx, receipt.objectRef)).toEqual({ exists: true, size: 8 });
    const opened = await driver.openDownloadStream(ctx, { objectRef: receipt.objectRef, range: { start: 1, end: 3 } });
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('bcd');
    expect(opened.size).toBe(data.length);
    await driver.deleteObject(ctx, receipt.objectRef);
    expect(await driver.headObject(ctx, receipt.objectRef)).toEqual({ exists: false });
  });
});
