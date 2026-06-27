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

@WebSocketGateway({
  namespace: '/alerts',
  cors: { origin: '*' },
  pingInterval: 30000,
  pingTimeout: 10000,
})
export class AlertGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AlertGateway.name);

  afterInit(): void {
    this.logger.log('Alert WebSocket Gateway 已初始化 (namespace: /alerts)');
  }

  handleConnection(client: Socket): void {
    this.logger.log(`客户端已连接: ${client.id}`);
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
