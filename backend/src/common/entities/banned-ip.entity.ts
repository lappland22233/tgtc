import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('banned_ips')
export class BannedIP {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ unique: true })
  ip: string;

  @Column({ nullable: true, type: 'varchar' })
  reason: string | null;

  @Column({ default: false })
  isPermanent: boolean;

  @Column({ nullable: true, type: 'timestamp' })
  expiresAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
