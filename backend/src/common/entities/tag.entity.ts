import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Unique,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

@Entity('tags')
@Unique(['name', 'userId'])
export class Tag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 50 })
  name: string;

  @Column({ length: 7, default: '#0052d9' })
  color: string;

  /** 所属用户 ID。单列索引由迁移 CoreInfraFixes1790700300000 创建。 */
  @Index('idx_tags_userId')
  @Column()
  userId: string;

  /** 所属用户关系（FK 已在数据库中存在，onDelete CASCADE） */
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @CreateDateColumn()
  createdAt: Date;
}
