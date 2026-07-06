import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Unique,
} from 'typeorm';

@Entity('tags')
@Unique(['name', 'userId'])
export class Tag {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ length: 50 })
  name: string;

  @Column({ length: 7, default: '#0052d9' })
  color: string;

  @Column()
  userId: string;

  @CreateDateColumn()
  createdAt: Date;
}
