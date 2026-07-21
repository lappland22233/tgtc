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

  /**
   * 封禁到期时间。
   * 不变量：当 isPermanent = false 时必须设置 expiresAt（非空）。
   * 登录封禁检查为 `isPermanent = true OR (isPermanent = false AND expiresAt > now)`，
   * 若非永久封禁的 expiresAt 为 NULL，该比较恒为 false，封禁会静默失效（fail-open）。
   * 因此创建封禁的调用方必须保证非永久封禁携带有效的 expiresAt。
   */
  @Column({ nullable: true, type: 'timestamp' })
  expiresAt: Date | null;

  @Column({ nullable: true, type: 'timestamp', name: 'unbanned_at' })
  unbannedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
