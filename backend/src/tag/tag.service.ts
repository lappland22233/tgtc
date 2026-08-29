import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Tag } from '../common/entities/tag.entity';
import { AuditService } from '../common/services/audit.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { databaseForUpdate, databaseQuery, getDatabaseType, isDatabaseUniqueViolation } from '../database/database-types';

@Injectable()
export class TagService {
  constructor(
    @InjectRepository(Tag)
    private readonly tagRepository: Repository<Tag>,
    private readonly auditService: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  async findAll(userId: string): Promise<{ tags: (Tag & { fileCount: number })[] }> {
    const tags = await this.tagRepository
      .createQueryBuilder('tag')
      .leftJoin('file_tags', 'ft', 'ft."tagId" = tag.id')
      // 仅统计未软删除的文件，避免计数偏大
      .leftJoin('files', 'f', 'f."id" = ft."fileId" AND f."isDeleted" = false')
      .select('tag.id', 'id')
      .addSelect('tag.name', 'name')
      .addSelect('tag.color', 'color')
      .addSelect('tag.userId', 'userId')
      .addSelect('tag.createdAt', 'createdAt')
      .addSelect('CAST(COUNT(f."id") AS INTEGER)', 'fileCount')
      .where('tag.userId = :userId', { userId })
      .groupBy('tag.id')
      .orderBy('tag.createdAt', 'ASC')
      .getRawMany();

    return {
      tags: tags.map(row => ({
        id: row.id,
        name: row.name,
        color: row.color,
        userId: row.userId,
        createdAt: row.createdAt,
        fileCount: Number(row.fileCount) || 0,
      } as Tag & { fileCount: number })),
    };
  }

  async create(userId: string, dto: CreateTagDto): Promise<Tag> {
    // 每用户标签数量上限，防止无限制创建
    const MAX_TAGS_PER_USER = 200;
    const currentCount = await this.tagRepository.count({ where: { userId } });
    if (currentCount >= MAX_TAGS_PER_USER) {
      throw new ConflictException(`标签数量已达上限（${MAX_TAGS_PER_USER}）`);
    }

    // 检查同一用户下标签名是否重复
    const existing = await this.tagRepository.findOne({
      where: { name: dto.name, userId },
    });
    if (existing) {
      throw new ConflictException('标签名称已存在');
    }

    const tag = this.tagRepository.create({
      name: dto.name,
      color: dto.color || '#0052d9',
      userId,
    });

    let saved: Tag;
    try {
      saved = await this.tagRepository.save(tag);
    } catch (error) {
      // TOCTOU：并发重名可能在 findOne 之后命中唯一约束，跨数据库转为 409
      if (isDatabaseUniqueViolation(error)) {
        throw new ConflictException('标签名称已存在');
      }
      throw error;
    }

    this.auditService.log({
      action: 'tag_create',
      userId,
      resourceType: 'tag',
      resourceId: saved.id,
      metadata: { name: saved.name, color: saved.color },
    });

    return saved;
  }

  async update(userId: string, id: string, dto: UpdateTagDto): Promise<Tag> {
    // 空更新防护：两个字段均可选，传 {} 时不执行更新
    if (dto.name === undefined && dto.color === undefined) {
      throw new BadRequestException('没有可更新的字段');
    }

    const tag = await this.tagRepository.findOne({ where: { id } });
    if (!tag) {
      throw new NotFoundException('标签不存在');
    }
    if (tag.userId !== userId) {
      throw new ForbiddenException('无权修改此标签');
    }

    // 检查名称冲突
    if (dto.name && dto.name !== tag.name) {
      const existing = await this.tagRepository.findOne({
        where: { name: dto.name, userId },
      });
      if (existing) {
        throw new ConflictException('标签名称已存在');
      }
    }

    try {
      await this.tagRepository.update(id, dto);
    } catch (error) {
      // TOCTOU：并发重命名可能命中唯一约束（23505），转为 409
      if ((error as { code?: string })?.code === '23505') {
        throw new ConflictException('标签名称已存在');
      }
      throw error;
    }

    this.auditService.log({
      action: 'tag_update',
      userId,
      resourceType: 'tag',
      resourceId: id,
      metadata: { before: { name: tag.name, color: tag.color }, after: dto },
    });

    return this.tagRepository.findOneOrFail({ where: { id } });
  }

  async delete(userId: string, id: string): Promise<void> {
    const tag = await this.tagRepository.findOne({ where: { id } });
    if (!tag) {
      throw new NotFoundException('标签不存在');
    }
    if (tag.userId !== userId) {
      throw new ForbiddenException('无权删除此标签');
    }

    await this.dataSource.transaction(async (manager) => {
      // 与文件标签替换保持一致：先锁 tags 父行，再由级联删除 file_tags。
      const lockedTags = await databaseQuery<Array<{ id: string }>>(manager, `SELECT id FROM tags WHERE id = $1${databaseForUpdate(manager.connection.options.type)}`, [id], getDatabaseType());
      if (lockedTags.length === 0) {
        throw new NotFoundException('标签不存在');
      }
      await manager.delete(Tag, id);
    });

    this.auditService.log({
      action: 'tag_delete',
      userId,
      resourceType: 'tag',
      resourceId: id,
      metadata: { name: tag.name },
    });
  }

  /** 校验标签所属用户 */
  async assertOwner(userId: string, tagIds: string[]): Promise<void> {
    if (tagIds.length === 0) return;

    // 去重：含重复 id 时 count !== tagIds.length 会误判越权
    const uniqueIds = [...new Set(tagIds)];

    const count = await this.tagRepository
      .createQueryBuilder('tag')
      .where('tag.id IN (:...ids)', { ids: uniqueIds })
      .andWhere('tag.userId = :userId', { userId })
      .getCount();

    if (count !== uniqueIds.length) {
      throw new ForbiddenException('包含不属于您的标签');
    }
  }
}
