import { databaseColumnType } from '../../database/database-types';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * @deprecated 已无实际用途：副本扩散只有「用户账号从主群服务端转发到镜像群」一条链路，
 * 不存在「Bot 重新上传」可选路径。**列保留不删**（发布契约要求回退程序版本时无需回退数据库），
 * 新写入恒为 `user_copy`；历史行的取值仅供追溯。
 */
export type TelegramMirrorMode = 'bot_upload' | 'user_copy' | 'auto';

/** @deprecated 同上：不再存在降级策略（降级会产生第二次上传，已彻底移除） */
export type TelegramMirrorFallbackMode = 'disabled' | 'bot_upload';

/** 规则权限探测结论：untested=未检测；ok=通过；failed=失败 */
export type TelegramMirrorTestStatus = 'untested' | 'ok' | 'failed';

/**
 * 镜像规则（**多规则**：每条启用规则对应一个镜像群）。
 *
 * 字段语义（改造后）：
 * - `sourceChatId` = **主群**：副本扩散唯一的中转落点，所有启用规则必须一致
 *   （持有源消息的 Bot 先转发到主群，用户账号再从主群中继到各自镜像群）；
 * - `targetChatId` = **镜像群**（备份群）：该规则的扩散目标；
 * - `mode` / `fallbackMode` 为历史遗留列，见上方 `@deprecated`。
 *
 * 强校验（服务端权威）：
 * - `sourceChatId !== targetChatId`（中转落点与备份必须分离）；
 * - 镜像群不得等于任一 Bot 账号的主存储 Chat（避免账号/消息归属混淆）；
 * - 启用前必须完成主群/镜像群权限测试（`lastTestStatus='ok'`），
 *   且主群与其它启用规则一致。
 *
 * 环境变量不参与规则定义，全部走本表 + 后台热更新并写审计。
 */
@Entity('telegram_mirror_rules')
@Index('idx_tg_mirror_rules_enabled', ['enabled'])
export class TelegramMirrorRule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'boolean', default: false, comment: '是否启用（多规则：每条启用规则一个镜像群）' })
  enabled: boolean;

  @Column({ type: 'varchar', length: 64, comment: '规则名称' })
  name: string;

  @Column({ type: 'varchar', length: 32, comment: '主群 Chat（源群 / 主存储群：副本扩散唯一中转落点）' })
  sourceChatId: string;

  @Column({ type: 'varchar', length: 32, comment: '镜像群 Chat（备份群）' })
  targetChatId: string;

  /** @deprecated 历史列：新写入恒为 user_copy */
  @Column({ type: 'varchar', length: 16, default: 'bot_upload', comment: '[废弃] 历史镜像模式列' })
  mode: TelegramMirrorMode;

  /** 指定优先账号；为空时按能力与健康度选择 */
  @Column({ type: 'varchar', length: 64, nullable: true, comment: '优先账号 ID（可空）' })
  preferredAccountId: string | null;

  /** @deprecated 历史列：降级路径已移除 */
  @Column({ type: 'varchar', length: 16, default: 'disabled', comment: '[废弃] 历史降级策略列' })
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
