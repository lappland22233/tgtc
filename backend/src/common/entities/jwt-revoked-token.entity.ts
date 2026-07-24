import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('jwt_revoked_tokens')
@Index('IDX_jwt_revoked_tokens_expiresAt', ['expiresAt'])
export class JwtRevokedToken {
  @PrimaryColumn({ length: 64 })
  jti: string;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @CreateDateColumn()
  revokedAt: Date;
}
