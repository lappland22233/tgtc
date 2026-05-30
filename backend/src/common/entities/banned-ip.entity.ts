import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('banned_ips')
export class BannedIP {
  @PrimaryGeneratedColumn('uuid')
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
