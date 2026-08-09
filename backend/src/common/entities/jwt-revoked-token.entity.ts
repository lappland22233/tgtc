import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('jwt_revoked_tokens')
@Index('IDX_jwt_revoked_tokens_expiresAt', ['expiresAt'])
export class JwtRevokedToken {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  jti: string;

  // 兼容早期仅记录 jti/expiresAt/revokedAt 的吊销表数据；新吊销记录始终写入 userId。
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @CreateDateColumn()
  revokedAt: Date;
}
