import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { User, UserRole } from '../common/entities/user.entity';
import { RateLimitService } from '../common/services/rate-limit.service';

@WebSocketGateway({
  namespace: '/alerts',
  cors: {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // 与主应用 CORS 配置保持一致：读取 CORS_ORIGINS，未配置（或为空）时回退到前端地址，
      // 避免空字符串配置导致 allowed 为空数组、生产环境拒绝所有合法连接
      const configured = (process.env.CORS_ORIGINS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const allowed = configured.length > 0
        ? configured
        : [process.env.FRONTEND_URL || 'http://localhost:5173'];
      // 开发环境允许无 origin 请求，生产环境拒绝
      if (process.env.NODE_ENV !== 'production' && !origin) {
        callback(null, true);
      } else if (origin && allowed.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin || '(none)'} not allowed by CORS`), false);
      }
    },
    credentials: true,
  },
  pingInterval: 30000,
  pingTimeout: 10000,
})
export class AlertGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AlertGateway.name);

  /** 广播限流：1 秒滑动窗口内最多推送的告警条数 */
  private static readonly BROADCAST_LIMIT_PER_SEC = 20;
  /** 最近 1 秒内的广播时间戳 */
  private broadcastTimestamps: number[] = [];
  /** 因限流被丢弃的告警计数 */
  private throttledCount = 0;
  /** 上次发送限流通知的时间 */
  private lastThrottleNoticeAt = 0;

  /** 生命周期内复核认证的间隔（毫秒）：每 5 分钟重新 verify + 查用户状态/封禁，失败即断开 */
  private static readonly REAUTH_INTERVAL_MS = 5 * 60 * 1000;
  /** 生命周期复核定时器（未 `.unref` 时可能阻止进程退出，此处 unref 避免阻塞优雅关闭） */
  private reauthTimer: NodeJS.Timeout | null = null;

  /** G8-18：同一 IP 每秒最多允许的握手尝试次数 */
  private static readonly HANDSHAKE_RATE_PER_SEC = 5;
  /** G8-18：同一 IP 允许的最大并发连接数（超出的握手直接拒绝） */
  private static readonly MAX_CONN_PER_IP = 5;
  /** G8-18：无效 token 短期封禁时长（毫秒）——1 分钟 */
  private static readonly INVALID_TOKEN_BAN_MS = 60 * 1000;

  /** G8-18：按 IP 统计当前活跃连接数 */
  private readonly activeConnectionsByIp = new Map<string, number>();

  constructor(
    private readonly jwtService: JwtService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly rateLimitService: RateLimitService,
  ) {}

  afterInit(): void {
    this.logger.log('Alert WebSocket Gateway 已初始化 (namespace: /alerts，仅 SUPER_ADMIN 可连接)');
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      // G8-18：按 IP 限流握手并发/速率，防止未认证连接无限握手打满资源。
      const ip = this.extractIp(client);
      if (ip) {
        // 并发连接上限
        const current = this.activeConnectionsByIp.get(ip) || 0;
        if (current >= AlertGateway.MAX_CONN_PER_IP) {
          this.logger.warn(`连接拒绝: ${client.id} IP ${ip} 并发连接数超限`);
          client.disconnect();
          return;
        }
        // 握手速率限流（每秒最多 HANDSHAKE_RATE_PER_SEC 次）
        const rate = await this.rateLimitService.checkAndIncrement(
          `ws-alerts:${ip}`,
          'ws_alerts_handshake',
          AlertGateway.HANDSHAKE_RATE_PER_SEC,
          60 * 1000,
          1000,
        );
        if (!rate.allowed) {
          this.logger.warn(`连接拒绝: ${client.id} IP ${ip} 握手过于频繁`);
          client.disconnect();
          return;
        }
      }

      // 支持两种 token 传递方式：handshake.auth.token 或 Authorization header
      const token =
        (client.handshake.auth as { token?: string } | undefined)?.token
        || (client.handshake.headers?.authorization as string | undefined)?.replace(/^Bearer\s+/i, '');

      if (!token) {
        this.logger.warn(`连接拒绝: ${client.id} 未提供 token`);
        this.recordIpAttempt(client);
        client.disconnect();
        return;
      }

      let payload: { sub: string; email: string; role: string };
      try {
        // 显式限定算法为 HS256，与签发算法一致，防止 alg=none / 算法混淆攻击
        payload = this.jwtService.verify(token, { algorithms: ['HS256'] });
      } catch {
        this.logger.warn(`连接拒绝: ${client.id} token 验证失败`);
        this.recordIpAttempt(client);
        client.disconnect();
        return;
      }

      const user = await this.userRepository.findOne({ where: { id: payload.sub } });
      if (!user || user.isBanned) {
        this.logger.warn(`连接拒绝: ${client.id} 用户不存在或已封禁`);
        client.disconnect();
        return;
      }

      if (user.role !== UserRole.SUPER_ADMIN) {
        this.logger.warn(`连接拒绝: ${client.id} 用户 ${user.email} 角色非 SUPER_ADMIN`);
        client.disconnect();
        return;
      }

      // 认证成功后才加入专用房间；所有敏感广播仅发送到该房间，
      // 即使 namespace 连接建立到鉴权完成之间存在窗口，也不会收到告警数据。
      (client.data as { user?: User; token?: string }).user = user;
      (client.data as { token?: string }).token = token;
      // 记录 IP 并发计数，便于断开时释放槽位
      if (ip) {
        (client.data as { wsIp?: string }).wsIp = ip;
        this.activeConnectionsByIp.set(ip, (this.activeConnectionsByIp.get(ip) || 0) + 1);
      }
      await client.join('super-admins');
      this.logger.log(`管理员已连接: ${client.id} (user: ${user.email})`);
      this.startReauthLoop();
    } catch (error: unknown) {
      this.logger.error(`handleConnection 异常: ${error instanceof Error ? error.message : String(error)}`);
      client.disconnect();
    }
  }

  /** G8-18：从握手信息提取客户端 IP（优先 x-forwarded-for 首项，回退 remoteAddress） */
  private extractIp(client: Socket): string | null {
    const xff = client.handshake?.headers?.['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      return xff.split(',')[0].trim() || null;
    }
    const addr = client.handshake?.address;
    return typeof addr === 'string' && addr ? addr : null;
  }

  /** G8-18：无效 token 尝试对该 IP 短期封禁（禁止后续握手），防无限重试 */
  private recordIpAttempt(client: Socket): void {
    const ip = this.extractIp(client);
    if (!ip) return;
    this.rateLimitService
      .checkAndIncrement(
        `ws-alerts-invalid:${ip}`,
        'ws_alerts_invalid',
        // 3 次无效尝试即触发 1 分钟封禁
        3,
        AlertGateway.INVALID_TOKEN_BAN_MS,
        60 * 1000,
      )
      .catch((err) => this.logger.warn(`无效 token 封禁记录失败: ${(err as Error).message}`));
  }

  /**
   * 生命周期内复核认证：每 5 分钟重新 verify token + 查询用户状态/封禁/角色，
   * 任何一项失败即断开连接。防止连接建立后被降权、封禁或登出的原超管持续接收实时告警。
   */
  private startReauthLoop(): void {
    if (this.reauthTimer) return;
    this.reauthTimer = setInterval(async () => {
      try {
        for (const [, client] of this.server.of('/alerts').sockets as Map<string, Socket>) {
          const data = client.data as { user?: User; token?: string };
          const token = data?.token;
          const user = data?.user;
          if (!token || !user) {
            client.disconnect();
            continue;
          }
          try {
            // 重新验签：登出（吊销）后 token 失效即断开
            const payload = this.jwtService.verify(token, { algorithms: ['HS256'] }) as { sub: string };
            // 查询最新用户状态：封禁 / 删除 / 角色降级均断开
            const fresh = await this.userRepository.findOne({ where: { id: payload.sub } });
            if (!fresh || fresh.isBanned || fresh.role !== UserRole.SUPER_ADMIN) {
              this.logger.warn(`管理员连接复核未通过，断开: ${client.id} (user: ${fresh?.email ?? 'unknown'})`);
              client.disconnect();
            }
          } catch {
            this.logger.warn(`管理员连接 token 已失效，断开: ${client.id}`);
            client.disconnect();
          }
        }
      } catch (error: unknown) {
        this.logger.error(`管理员连接复核异常: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, AlertGateway.REAUTH_INTERVAL_MS);
    // 不阻止进程退出，避免阻止优雅关闭
    if (typeof this.reauthTimer.unref === 'function') {
      this.reauthTimer.unref();
    }
  }

  private stopReauthLoop(): void {
    if (this.reauthTimer) {
      clearInterval(this.reauthTimer);
      this.reauthTimer = null;
    }
  }

  handleDisconnect(client: Socket): void {
    // 释放 IP 并发槽位
    const ip = (client.data as { wsIp?: string } | undefined)?.wsIp;
    if (ip) {
      const remaining = (this.activeConnectionsByIp.get(ip) || 1) - 1;
      if (remaining > 0) this.activeConnectionsByIp.set(ip, remaining);
      else this.activeConnectionsByIp.delete(ip);
    }
    this.logger.log(`客户端已断开: ${client.id}`);
    // 无剩余连接时停止生命周期复核定时器，避免空转
    if (this.reauthTimer && this.server.of('/alerts').sockets.size === 0) {
      this.stopReauthLoop();
    }
  }

  /** 广播新告警给所有连接的客户端（带频率限制，防止告警风暴） */
  broadcastAlert(alert: {
    id: string;
    ruleId: string;
    level: string;
    title: string;
    message: string;
    createdAt: Date;
  }): void {
    const now = Date.now();
    // 滑动窗口限流：仅保留最近 1 秒的广播时间戳
    this.broadcastTimestamps = this.broadcastTimestamps.filter((t) => now - t < 1000);

    if (this.broadcastTimestamps.length >= AlertGateway.BROADCAST_LIMIT_PER_SEC) {
      // 超过频率上限：丢弃本次广播并累计计数，避免 WebSocket 消息风暴
      this.throttledCount++;
      // 每秒最多发送一次限流通知，告知客户端有告警被抑制
      if (now - this.lastThrottleNoticeAt >= 1000) {
        this.server.to('super-admins').emit('alerts-throttled', { dropped: this.throttledCount });
        this.throttledCount = 0;
        this.lastThrottleNoticeAt = now;
      }
      return;
    }

    this.broadcastTimestamps.push(now);
    this.server.to('super-admins').emit('new-alert', alert);
  }

  /** 广播未确认告警计数 */
  broadcastUnacknowledgedCount(count: number): void {
    this.server.to('super-admins').emit('unacknowledged-count', { count });
  }

  @SubscribeMessage('ping')
  handlePing(_client: Socket): { status: string } {
    return { status: 'pong' };
  }
}
