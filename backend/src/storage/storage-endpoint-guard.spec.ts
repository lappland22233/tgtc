import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { assertEndpointNotInternal, validateBackendConfig } from './storage-backends.service';

/**
 * C-06：存储端点此前只校验 http(s) 协议，地址完全不设限。
 * 管理员会话被劫持后可借连通性测试探测云元数据或内网服务。
 */
describe('assertEndpointNotInternal（C-06）', () => {
  const original = process.env.STORAGE_ALLOW_PRIVATE_ENDPOINT;
  afterEach(() => {
    if (original === undefined) delete process.env.STORAGE_ALLOW_PRIVATE_ENDPOINT;
    else process.env.STORAGE_ALLOW_PRIVATE_ENDPOINT = original;
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.170.2/v2/credentials',
    'http://[fe80::1]/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata/',
    'http://instance-data/',
  ])('链路本地/云元数据地址始终拒绝：%s', (url) => {
    // 即使显式允许私网也不放行——这些地址上没有合法存储后端
    process.env.STORAGE_ALLOW_PRIVATE_ENDPOINT = 'true';
    expect(() => assertEndpointNotInternal(url, '端点')).toThrow(BadRequestException);
  });

  it.each([
    'http://127.0.0.1:9000',
    'http://localhost:9000',
    'http://[::1]:9000',
    'http://10.0.0.5:9000',
    'http://192.168.1.10:9000',
    'http://172.16.0.1:9000',
    'http://172.31.255.254:9000',
    'http://[fd00::1]:9000',
  ])('默认拒绝环回/私网地址：%s', (url) => {
    delete process.env.STORAGE_ALLOW_PRIVATE_ENDPOINT;
    expect(() => assertEndpointNotInternal(url, '端点')).toThrow(BadRequestException);
  });

  it('显式开启 STORAGE_ALLOW_PRIVATE_ENDPOINT 后放行内网 MinIO / 局域网 WebDAV', () => {
    process.env.STORAGE_ALLOW_PRIVATE_ENDPOINT = 'true';
    expect(() => assertEndpointNotInternal('http://192.168.1.10:9000', '端点')).not.toThrow();
    expect(() => assertEndpointNotInternal('http://127.0.0.1:9000', '端点')).not.toThrow();
  });

  it('172.32 及以上不属于私网段，不被误拒', () => {
    delete process.env.STORAGE_ALLOW_PRIVATE_ENDPOINT;
    expect(() => assertEndpointNotInternal('http://172.32.0.1:9000', '端点')).not.toThrow();
  });

  it('公网地址与域名正常放行', () => {
    delete process.env.STORAGE_ALLOW_PRIVATE_ENDPOINT;
    expect(() => assertEndpointNotInternal('https://s3.amazonaws.com', '端点')).not.toThrow();
    expect(() => assertEndpointNotInternal('https://minio.example.com:9000', '端点')).not.toThrow();
  });

  it('非法 URL 抛 BadRequest 而不是让 URL 构造异常冒泡', () => {
    expect(() => assertEndpointNotInternal('not-a-url', '端点')).toThrow(BadRequestException);
  });
});

describe('validateBackendConfig 接线（C-06）', () => {
  const original = process.env.STORAGE_ALLOW_PRIVATE_ENDPOINT;
  afterEach(() => {
    if (original === undefined) delete process.env.STORAGE_ALLOW_PRIVATE_ENDPOINT;
    else process.env.STORAGE_ALLOW_PRIVATE_ENDPOINT = original;
  });

  it('S3 endpoint 指向元数据地址时拒绝', () => {
    expect(() => validateBackendConfig('s3', {
      bucket: 'b', region: 'us-east-1', endpoint: 'http://169.254.169.254',
    })).toThrow(BadRequestException);
  });

  it('WebDAV url 指向私网时默认拒绝', () => {
    delete process.env.STORAGE_ALLOW_PRIVATE_ENDPOINT;
    expect(() => validateBackendConfig('webdav', { url: 'http://10.0.0.5:8080' }))
      .toThrow(BadRequestException);
  });

  it('WebDAV url 公网正常通过并去除尾斜杠', () => {
    const result = validateBackendConfig('webdav', { url: 'https://dav.example.com/' });
    expect((result as any).url).toBe('https://dav.example.com');
  });

  it('S3 未配 endpoint 时不受影响（走官方 AWS）', () => {
    const result = validateBackendConfig('s3', { bucket: 'b', region: 'us-east-1' });
    expect(result).toEqual({ bucket: 'b', region: 'us-east-1' });
  });
});