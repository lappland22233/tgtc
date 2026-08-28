import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export type ShareAuditAction = 'create' | 'revoke' | 'access' | 'consume';

@Entity('share_audits')
@Index('idx_share_audits_createdAt', ['createdAt'])
export class ShareAudit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  jti: string;

  @Column()
  fileId: string;

  @Column({ nullable: true, comment: '访问者ID，匿名访问可为空' })
  userId: string;

  @Column({ type: 'varchar', default: 'consume' })
  action: ShareAuditAction;

  @Column({ nullable: true, default: '' })
  ip: string;

  @CreateDateColumn()
  createdAt: Date;
}
