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
      // 与主应用 CORS 配置保持一致：读取 CORS_ORIGINS，未配置时回退到本地开发地址
      const allowed = process.env.CORS_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean)
        || [process.env.FRONTEND_URL || 'http://localhost:5173'];
      // 允许无 origin 的请求（如 curl、同源请求），或匹配白名单的请求
      if (!origin || allowed.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`), false);
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

      // 将用户信息附加到 client.data，便于后续 SubscribeMessage 处理器使用
      (client.data as { user?: User }).user = user;
      this.logger.log(`管理员已连接: ${client.id} (user: ${user.email})`);
    } catch (error: unknown) {
      this.logger.error(`handleConnection 异常: ${error instanceof Error ? error.message : String(error)}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`客户端已断开: ${client.id}`);
  }

  /** 广播新告警给所有连接的客户端 */
  broadcastAlert(alert: {
    id: string;
    ruleId: string;
    level: string;
    title: string;
    message: string;
    createdAt: Date;
  }): void {
    this.server.emit('new-alert', alert);
  }

  /** 广播未确认告警计数 */
  broadcastUnacknowledgedCount(count: number): void {
    this.server.emit('unacknowledged-count', { count });
  }

  @SubscribeMessage('ping')
  handlePing(_client: Socket): { status: string } {
    return { status: 'pong' };
  }
}
