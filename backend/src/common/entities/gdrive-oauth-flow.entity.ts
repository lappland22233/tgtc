import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('gdrive_oauth_flows')
export class GDriveOAuthFlow {
  @PrimaryColumn('varchar', { length: 64 })
  stateHash: string;

  @Column('varchar', { length: 64 })
  bindingHash: string;

  @Index('idx_gdrive_oauth_flows_expires')
  @Column('bigint')
  expiresAt: number;
}
