import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { JwtRevokedToken } from '../common/entities/jwt-revoked-token.entity';

@Injectable()
export class JwtRevocationService {
  constructor(
    @InjectRepository(JwtRevokedToken)
    private readonly repository: Repository<JwtRevokedToken>,
  ) {}

  async revoke(jti: string, expiresAt: Date): Promise<void> {
    if (!jti || expiresAt <= new Date()) return;
    await this.repository.upsert({ jti, expiresAt }, ['jti']);
  }

  async isRevoked(jti?: string): Promise<boolean> {
    if (!jti) return true;
    return this.repository.exists({ where: { jti } });
  }

  async cleanupExpired(): Promise<void> {
    await this.repository.delete({ expiresAt: LessThan(new Date()) });
  }
}
