import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tag } from '../common/entities/tag.entity';
import { AuditService } from '../common/services/audit.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';

@Injectable()
export class TagService {
  constructor(
    @InjectRepository(Tag)
    private readonly tagRepository: Repository<Tag>,
    private readonly auditService: AuditService,
  ) {}

  async findAll(userId: string): Promise<{ tags: (Tag & { fileCount: number })[] }> {
    const tags = await this.tagRepository
      .createQueryBuilder('tag')
      .leftJoin('file_tags', 'ft', 'ft."tagId" = tag.id')
      .select('tag.id', 'id')
      .addSelect('tag.name', 'name')
      .addSelect('tag.color', 'color')
      .addSelect('tag.userId', 'userId')
      .addSelect('tag.createdAt', 'createdAt')
      .addSelect('CAST(COUNT(ft."fileId") AS INTEGER)', 'fileCount')
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

    const saved = await this.tagRepository.save(tag);

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

    await this.tagRepository.update(id, dto);

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

    await this.tagRepository.delete(id);

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

    const count = await this.tagRepository
      .createQueryBuilder('tag')
      .where('tag.id IN (:...ids)', { ids: tagIds })
      .andWhere('tag.userId = :userId', { userId })
      .getCount();

    if (count !== tagIds.length) {
      throw new ForbiddenException('包含不属于您的标签');
    }
  }
}
