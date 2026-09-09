import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { databaseColumnType } from '../../database/database-types';

/**
 * API 密钥 IP 白名单（v1.2.6，按每把密钥独立配置）。
 *
 * - 规则支持单 IP（IPv4/IPv6）与 CIDR（IPv4: /0-/32，IPv6: /0-/128）；
 * - 空名单 = 不限制来源；
 * - 认证链路在校验密钥身份后、授予请求上下文前执行匹配，
 *   不命中即拒绝（401，不暴露密钥有效性细节）并记录使用日志。
 */
@Entity('api_key_ip_allowlist')
@Index('idx_api_key_ip_allowlist_keyId', ['apiKeyId'])
export class ApiKeyIpAllowlist {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属 API 密钥 */
  @Column({ type: databaseColumnType('uuid') as 'uuid' })
  apiKeyId: string;

  /** 单 IP 或 CIDR 规则原文（如 192.168.1.0/24、2408:8456::/32） */
  @Column({ type: 'varchar', length: 64 })
  rule: string;

  @CreateDateColumn()
  createdAt: Date;
}
