import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { join } from 'path';
import { AppModule } from './app.module';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // 配置反向代理信任，确保 req.ip 获取真实客户端 IP
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.setGlobalPrefix('api');

  // 全局响应结构统一包装为 { code, message, data }
  app.useGlobalInterceptors(new TransformInterceptor());

  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : [process.env.FRONTEND_URL || 'http://localhost:8080'];

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
  expressApp.get('*', (req, res, next) => {
    // 跳过 API 路由
    if (req.path.startsWith('/api/') || req.path === '/api') {
      return next();
    }
    // 跳过已有静态文件
    if (req.path.includes('.')) {
      return next();
    }
    // 返回 index.html（SPA 路由）
    res.sendFile(join(frontendDist, 'index.html'));
  });

  const port = process.env.APP_PORT || 8080;
  const host = process.env.APP_HOST || '127.0.0.1';
  await app.listen(port, host);
  logger.log(`Application is running on: http://${host}:${port}`);
  logger.log(`Frontend served from: ${frontendDist}`);
  logger.log(`CORS origins: ${allowedOrigins.join(', ')}`);
  logger.log(`Global prefix: /api`);
}

bootstrap();
