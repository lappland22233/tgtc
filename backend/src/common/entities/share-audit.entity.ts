import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export type ShareAuditAction = 'create' | 'revoke' | 'access';

@Entity('share_audits')
export class ShareAudit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  jti: string;

  @Column()
  fileId: string;

  @Column()
  userId: string;

  @Column({ type: 'varchar' })
  action: ShareAuditAction;

  @Column({ nullable: true })
  ip: string;

  @CreateDateColumn()
  createdAt: Date;
}
