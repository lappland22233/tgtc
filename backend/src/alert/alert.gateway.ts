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

  constructor(
    private readonly jwtService: JwtService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  afterInit(): void {
    this.logger.log('Alert WebSocket Gateway 已初始化 (namespace: /alerts，仅 SUPER_ADMIN 可连接)');
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      // 支持两种 token 传递方式：handshake.auth.token 或 Authorization header
      const token =
        (client.handshake.auth as { token?: string } | undefined)?.token
        || (client.handshake.headers?.authorization as string | undefined)?.replace(/^Bearer\s+/i, '');

      if (!token) {
        this.logger.warn(`连接拒绝: ${client.id} 未提供 token`);
        client.disconnect();
        return;
      }

      let payload: { sub: string; email: string; role: string };
      try {
        payload = this.jwtService.verify(token);
      } catch {
        this.logger.warn(`连接拒绝: ${client.id} token 验证失败`);
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
      (client.data as { user?: User }).user = user;
      await client.join('super-admins');
      this.logger.log(`管理员已连接: ${client.id} (user: ${user.email})`);
    } catch (error: unknown) {
      this.logger.error(`handleConnection 异常: ${error instanceof Error ? error.message : String(error)}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`客户端已断开: ${client.id}`);
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
