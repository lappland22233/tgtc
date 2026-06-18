import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

/** 审计日志操作类型 */
export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'register'
  | 'password_reset'
  | 'email_verify'
  | 'role_change'
  | 'user_create'
  | 'user_delete'
  | 'user_ban'
  | 'user_unban'
  | 'file_upload'
  | 'file_download'
  | 'file_delete'
  | 'file_share'
  | 'file_password_set'
  | 'file_password_remove'
  | 'file_access_change'
  | 'file_expiry_set'
  | 'config_change'
  | 'smtp_config_change'
  | 'upload_config_change'
  | 'auth_config_change'
  | 'ip_ban'
  | 'ip_unban'
  | 'batch_delete_files'
  | 'batch_markdown';

/** 审计日志状态 */
export enum AuditStatus {
  SUCCESS = 'success',
  FAILURE = 'failure',
}

@Entity('audit_logs')
export class AuditLog {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ nullable: true, comment: '操作者ID，匿名操作可为空' })
  userId: string;

  @Column({ type: 'varchar', length: 50, comment: '操作类型' })
  action: string;

  @Column({ nullable: true, comment: '操作IP' })
  ip: string;

  @Column({ nullable: true, comment: '资源类型' })
  resourceType: string;

  @Column({ nullable: true, comment: '资源ID' })
  resourceId: string;

  @Column({ type: 'json', nullable: true, comment: '元数据JSON（如变更前后值、失败原因等）' })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 20, default: AuditStatus.SUCCESS, comment: '操作状态：success / failure' })
  status: string;

  @CreateDateColumn({ comment: '创建时间' })
  createdAt: Date;
}
