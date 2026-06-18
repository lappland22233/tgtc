import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export type ShareAuditAction = 'create' | 'revoke' | 'access' | 'consume';

@Entity('share_audits')
export class ShareAudit {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ unique: true })
  jti: string;

  @Column()
  fileId: string;

  @Column({ default: '' })
  userId: string;

  @Column({ type: 'varchar', default: 'consume' })
  action: ShareAuditAction;

  @Column({ nullable: true, default: '' })
  ip: string;

  @CreateDateColumn()
  createdAt: Date;
}
