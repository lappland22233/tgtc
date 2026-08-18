import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { join } from 'path';
import { existsSync } from 'fs';
import { AppModule } from './app.module';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { validateEnv } from './config/env-validation';
import { FileLogger } from './common/file-logger';
import { isLegacyEncrypted } from './common/utils/crypto.util';

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
  app.enableShutdownHooks();

  // 配置反向代理信任，确保 req.ip 获取真实客户端 IP。
  // 安全默认：不信任任何代理（false）。仅当部署确实位于反向代理之后、且显式配置了
  // TRUST_PROXY_HOPS（可信代理层数）时才启用，避免攻击者直接伪造 X-Forwarded-For
  // 绕过 IP 维度限流/封禁（G9-01 / G1-07）。
  // 注意 TRUST_PROXY_HOPS=0 会被 Number() 解析为 falsy，故先 Number 再显式判断：
  // 仅当 Number.isFinite 且 >=0 时才使用（0 表示"直连，不信任任何代理"）。
  let trustProxy: boolean | number = false;
  const rawHops = process.env.TRUST_PROXY_HOPS;
  if (rawHops !== undefined && rawHops !== '') {
    const hops = Number(rawHops);
    if (Number.isFinite(hops) && hops >= 0) {
      trustProxy = hops;
    } else {
      throw new Error(
        `TRUST_PROXY_HOPS 取值非法: "${rawHops}"（应为非负整数，0 表示直连不信任代理）`,
      );
    }
  }
  app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);

  // 部署预检：若未显式配置 TRUST_PROXY_HOPS 且监听在 0.0.0.0（暴露到所有网卡），
  // 说明可能直连公网且无反向代理，此时 trust proxy 关闭、req.ip 取 socket 地址，
  // 伪造的 X-Forwarded-For 不会生效（安全）。但若实际部署在反代后却漏配该变量，
  // 真实客户端 IP 将无法解析，故给出 warning（不阻断启动，本地开发 127.0.0.1 不受影响）。
  const listenHost = process.env.APP_HOST || '127.0.0.1';
  if (rawHops === undefined && listenHost === '0.0.0.0') {
    logger.warn(
      '检测到监听 0.0.0.0 且未设置 TRUST_PROXY_HOPS：trust proxy 已关闭（安全默认）。' +
        '若本服务位于反向代理之后，请显式设置 TRUST_PROXY_HOPS=<可信代理层数> 以正确解析真实客户端 IP；' +
        '若直连公网，请务必通过反向代理（如 Caddy/nginx）暴露，切勿让 Node 直接监听公网端口。',
    );
  }

  app.setGlobalPrefix('api');

  // 全局响应结构统一包装为 { code, message, data }
  app.useGlobalInterceptors(new TransformInterceptor());

  // 全局异常过滤器：统一错误响应结构，生产环境不回显堆栈
  app.useGlobalFilters(new GlobalExceptionFilter());

  // 安全响应头（X-Content-Type-Options / X-Frame-Options / Referrer-Policy 等）。
  // CSP 交由前端 index.html 的 <meta> 控制（G9-06：确认前端 index.html 的 meta CSP
  // 覆盖所有 HTML 出口——SPA 回退返回的 index.html 即唯一 HTML 出口，其 <meta http-equiv=
  // "Content-Security-Policy"> 对所有导航请求生效）。
  // CORP 采用保守策略：全局保持 same-origin（限制跨源加载资源），仅对媒体直链路由
  // （/media/* 与 /files/public/*）在下方 URL 重写中间件中单独放宽为 cross-origin，
  // 以满足跨域媒体嵌入/防盗链需求，而非全局放开（G9-06）。
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );

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

  // 安全防护：credentials:true 与通配符 origin 组合会泄露凭据，禁止该配置
  if (allowedOrigins.includes('*')) {
    throw new Error('CORS 配置错误：启用 credentials 时 origin 不能为通配符 *，请显式列出允许的来源');
  }

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

  // G9-12：启动时检测存量旧格式（CBC/明文）加密值并告警，不自动改写。
  // 用户上传/配置中的敏感值若仍为旧格式，说明尚未执行 crypto v2 迁移脚本
  // （backend/scripts/migrate-crypto-v2.ts）。此处仅告警提示，不自动迁移，
  // 避免在密钥/盐不一致或迁移中断时破坏数据。检测失败不阻塞启动（仅记录）。
  await detectLegacyCryptoValues(app, logger);

  // 服务前端静态文件（生产构建产物）
  const frontendDist = join(__dirname, '..', '..', 'frontend', 'dist');
  app.useStaticAssets(frontendDist, { prefix: '/' });

  const expressApp = app.getHttpAdapter().getInstance();

  // 公开文件与媒体直链 URL 重写，让外部引用无需 /api 前缀。
  // 同时为媒体直链路由单独设置安全响应头（G9-06）：
  // - X-Content-Type-Options: nosniff 强制浏览器不嗅探 MIME 类型；
  // - Cross-Origin-Resource-Policy: cross-origin 仅在此类直链路由上放宽，
  //   允许跨源加载媒体资源（热链/嵌入），而全局 helmet 仍保持 same-origin。
  // 注意：不在此覆盖 Content-Disposition——控制器已按语义正确设置
  // （媒体 inline、下载 attachment）。
  // G9-07：中间件抛错时经 next(err) 交给 Express 兜底错误处理器统一输出错误契约。
  expressApp.use((req, _res, next) => {
    try {
      if (req.path.startsWith('/files/public/') || req.path.startsWith('/media/')) {
        // 上传/媒体直链：强制 nosniff，并在此单独放宽 CORP（不污染全局）
        _res.setHeader('X-Content-Type-Options', 'nosniff');
        _res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        req.url = req.path.startsWith('/media/')
          ? '/api/files' + req.url
          : '/api' + req.url;
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  // SPA 路由回退：非 /api 和非静态文件的请求返回 index.html
  // 仅对浏览器导航请求（Accept: text/html）回退，避免爬虫/监控工具因 200+HTML 误判所有路径都存在
  expressApp.get('/*splat', (req, res, next) => {
    try {
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
        const indexFile = join(frontendDist, 'index.html');
        // dist 缺失时直接 sendFile 会 ENOENT 致所有 HTML 导航 500，此处降级为 404
        if (existsSync(indexFile)) {
          return res.sendFile(indexFile);
        }
      }
      return next();
    } catch (err) {
      next(err);
    }
  });

  // Express 层兜底错误处理器（G9-07）：
  // 上述裸 Express 中间件（URL 重写 / SPA 回退）抛出的异常不会进入 Nest 的
  // GlobalExceptionFilter，此处注册一个 Express 错误处理器，将错误统一收敛为
  // { code, message, data: null } 契约，并返回通用 500 文案，避免内部细节外泄。
  // 注意：必须注册在最后，且显式保留 4 个参数（Express 依据参数个数识别错误处理器）。
  expressApp.use(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (err: unknown, req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          res.destroy();
        }
        return;
      }
      const safeUrl = ((req.originalUrl || req.url || '/').split('#')[0] ?? '/');
      const detail = err instanceof Error ? err.message : String(err);
      logger.error(`[Express 中间件异常] ${req.method} ${safeUrl}: ${detail}`);
      res.status(500).json({ code: 500, message: '服务器内部错误', data: null });
    },
  );

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

/**
 * G9-12：启动时扫描 system_configs，检测仍为旧版 CBC/明文格式的加密值并告警。
 * 仅告警不自动改写（保守策略）；DB 不可用或查询失败时静默跳过，不阻塞启动。
 */
async function detectLegacyCryptoValues(
  app: NestExpressApplication,
  logger: Logger,
): Promise<void> {
  try {
    const dataSource = app.get(DataSource);
    const rows: Array<{ key: string; value: string }> = await dataSource.query(
      'SELECT "key", "value" FROM system_configs',
    );
    const legacy = (rows ?? []).filter((r) => isLegacyEncrypted(r.value ?? ''));
    if (legacy.length > 0) {
      logger.warn(
        `检测到 ${legacy.length} 个旧版加密值（${legacy.map((r) => r.key).join(', ')}）` +
          '，缺少完整性校验（Padding Oracle/注入风险）。' +
          '请运行 backend/scripts/migrate-crypto-v2.ts 一次性迁移至 AES-256-GCM (v2)。',
      );
    }
  } catch (err) {
    // DB 未就绪或表不存在等场景：仅记录，不因检测失败阻止服务启动
    logger.warn(
      `旧版加密值检测失败（可忽略）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

bootstrap().catch((err) => {
  // 启动失败时显式记录并以非零码退出，避免 unhandled rejection
  // eslint-disable-next-line no-console
  console.error('[启动失败]', err);
  process.exit(1);
});
