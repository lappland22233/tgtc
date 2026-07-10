import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { join } from 'path';
import { AppModule } from './app.module';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { validateEnv } from './config/env-validation';
import { FileLogger } from './common/file-logger';

async function bootstrap() {
  const fileLogger = new FileLogger();
  const logger = new Logger('Bootstrap');

  // 启动时校验关键环境变量，失败则阻止启动
  try {
    validateEnv();
  } catch (err) {
    logger.error((err as Error).message);
    process.exit(1);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: fileLogger,
  });

  // 配置反向代理信任，确保 req.ip 获取真实客户端 IP
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.setGlobalPrefix('api');

  // 全局响应结构统一包装为 { code, message, data }
  app.useGlobalInterceptors(new TransformInterceptor());

  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
    : process.env.FRONTEND_URL
      ? [process.env.FRONTEND_URL]
      : (() => {
          if (process.env.NODE_ENV === 'production') {
            throw new Error('CORS_ORIGINS 或 FRONTEND_URL 环境变量未配置，生产环境禁止使用默认值');
          }
          return ['http://localhost:8080'];
        })();

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // 服务前端静态文件（生产构建产物）
  const frontendDist = join(__dirname, '..', '..', 'frontend', 'dist');
  app.useStaticAssets(frontendDist, { prefix: '/' });

  const expressApp = app.getHttpAdapter().getInstance();

  // 分享链接 URL 重写：/files/public/ -> /api/files/public/
  // 让公开文件链接无需 /api 前缀，保持分享 URL 简洁
  expressApp.use((req, _res, next) => {
    if (req.path.startsWith('/files/public/')) {
      req.url = '/api' + req.url;
    }
    next();
  });

  // SPA 路由回退：非 /api 和非静态文件的请求返回 index.html
  // 仅对浏览器导航请求（Accept: text/html）回退，避免爬虫/监控工具因 200+HTML 误判所有路径都存在
  expressApp.get('*', (req, res, next) => {
    // 跳过 API 路由
    if (req.path.startsWith('/api/') || req.path === '/api') {
      return next();
    }
    // 跳过已有静态文件
    if (req.path.includes('.')) {
      return next();
    }
    // 仅对浏览器导航请求回退 SPA
    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) {
      return res.sendFile(join(frontendDist, 'index.html'));
    }
    return next();
  });

  // 默认端口与 .env.example / README 保持一致（3000）
  const port = process.env.APP_PORT || 3000;
  const host = process.env.APP_HOST || '127.0.0.1';
  const httpServer = await app.listen(port, host);

  // HTTP 服务器超时配置（基于活动连接）：
  // - server.timeout 在有数据传输时自动重置，空闲后断开
  // - 大文件上传/分片上传时持续有数据流入，计时器不断重置，不会超时
  // - 设为 120s 为慢速网络留足安全余量（略大于 Cloudflare 100s 代理超时）
  // - 上传端点额外通过 req.setTimeout(0) 兜底
  httpServer.timeout = 120 * 1000;               // 空闲 120 秒超时，数据传输中不超时
  httpServer.keepAliveTimeout = 65 * 1000;       // Keep-Alive 连接空闲超时（略大于 LB 60s）
  httpServer.headersTimeout = 66 * 1000;          // 请求头超时（需大于 keepAliveTimeout）

  logger.log(`Application is running on: http://${host}:${port}`);
  logger.log(`Frontend served from: ${frontendDist}`);
  logger.log(`CORS origins: ${allowedOrigins.join(', ')}`);
  logger.log(`Global prefix: /api`);
  logger.log(`HTTP timeout: ${httpServer.timeout / 1000}s idle, auto-reset on activity`);
}

bootstrap();
