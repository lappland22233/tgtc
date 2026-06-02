import { DataSource } from 'typeorm';
import { User } from '../common/entities/user.entity';
import { File } from '../common/entities/file.entity';
import { SystemConfig } from '../common/entities/system-config.entity';
import { VerificationCode } from '../common/entities/verification-code.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { RateLimit } from '../common/entities/rate-limit.entity';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  username: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_DATABASE || 'file_distribution',
  entities: [User, File, SystemConfig, VerificationCode, BannedIP, ShareAudit, FileAccessLog, RateLimit],
  migrations: ['src/migrations/*.ts'],
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
