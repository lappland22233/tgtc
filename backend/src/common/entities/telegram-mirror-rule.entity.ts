import { databaseColumnType } from '../../database/database-types';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** 镜像模式：bot_upload=目标账号二次上传；user_copy=用户账号无源复制；auto=优先用户复制并可按策略降级 */
export type TelegramMirrorMode = 'bot_upload' | 'user_copy' | 'auto';

/** 降级策略：disabled=不降级（默认）；bot_upload=用户复制失败后允许 Bot 重新上传 */
export type TelegramMirrorFallbackMode = 'disabled' | 'bot_upload';

/** 规则权限探测结论：untested=未检测；ok=通过；failed=失败 */
export type TelegramMirrorTestStatus = 'untested' | 'ok' | 'failed';

/**
 * 镜像备份规则。
 *
 * 首发只允许一条 `enabled=true` 的规则，但结构预留多规则：
 * 数据库层只保证 `sourceChatId !== targetChatId` 的强校验在服务端执行；
 * 目标群还必须不等于任一 Bot 账号的主存储 Chat（避免账号/消息归属混淆）。
 *
 * 安全与一致性：
 * - 规则启用前必须完成源/目标权限测试（`lastTestStatus='ok'`）；
 * - 环境变量不参与规则定义，全部走本表 + 后台热更新并写审计。
 */
@Entity('telegram_mirror_rules')
@Index('idx_tg_mirror_rules_enabled', ['enabled'])
export class TelegramMirrorRule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'boolean', default: false, comment: '是否启用（首发只允许一条启用）' })
  enabled: boolean;

  @Column({ type: 'varchar', length: 64, comment: '规则名称' })
  name: string;

  @Column({ type: 'varchar', length: 32, comment: '源 Chat（主存储群 / 源群）' })
  sourceChatId: string;

  @Column({ type: 'varchar', length: 32, comment: '备份群 Chat' })
  targetChatId: string;

  @Column({ type: 'varchar', length: 16, default: 'bot_upload', comment: '镜像模式：bot_upload|user_copy|auto' })
  mode: TelegramMirrorMode;

  /** 指定优先账号；为空时按能力与健康度选择 */
  @Column({ type: 'varchar', length: 64, nullable: true, comment: '优先账号 ID（可空）' })
  preferredAccountId: string | null;

  /** 默认 disabled：降级会产生第二次上传，必须显式开启 */
  @Column({ type: 'varchar', length: 16, default: 'disabled', comment: '降级策略：disabled|bot_upload' })
  fallbackMode: TelegramMirrorFallbackMode;

  @Column({ type: 'boolean', default: true, comment: '是否镜像普通 Web 新上传' })
  includeWebUploads: boolean;

  @Column({ type: 'boolean', default: false, comment: '是否镜像 Bot 私聊入站文件' })
  includeBotInboundFiles: boolean;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '最近一次权限测试时间' })
  lastTestedAt: Date | null;

  @Column({ type: 'varchar', length: 16, default: 'untested', comment: '最近一次权限测试结论' })
  lastTestStatus: TelegramMirrorTestStatus;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: '最近一次权限测试摘要（脱敏）' })
  lastTestSummary: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '创建人（管理员用户 ID）' })
  createdBy: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '最近修改人（管理员用户 ID）' })
  updatedBy: string | null;

  @CreateDateColumn({ comment: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ comment: '更新时间' })
  updatedAt: Date;
}
