import { Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User, UserRole } from '../common/entities/user.entity';
import { File } from '../common/entities/file.entity';
import { Folder } from '../common/entities/folder.entity';
import { Tag } from '../common/entities/tag.entity';
import { ShareLink, ShareLinkStatus } from '../common/entities/share-link.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { AuditService } from '../common/services/audit.service';
import { BCRYPT_ROUNDS } from '../common/constants/bcrypt';
import { FILE_DELETE_GRACE_MS } from '../common/constants/durations';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(File)
    private fileRepository: Repository<File>,
    @InjectRepository(FileAccessLog)
    private accessLogRepository: Repository<FileAccessLog>,
    @InjectDataSource()
    private dataSource: DataSource,
    private auditService: AuditService,
  ) {}

  async findAll(page = 1, limit = 20, search?: string): Promise<{ users: Partial<User>[]; total: number }> {
    // B-1: 边界校验，防止 DoS
    page = Math.max(1, Math.min(page, 100000));
    limit = Math.max(1, Math.min(limit, 100));

    const queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .select(['user.id', 'user.email', 'user.role', 'user.isBanned', 'user.emailVerified', 'user.lastLoginIP', 'user.lastLoginAt', 'user.createdAt'])
      .skip((page - 1) * limit)
      .take(limit)
      .orderBy('user.createdAt', 'DESC');

    if (search) {
      // 转义 SQL 通配符防止 LIKE 注入。必须先转义反斜杠本身，再转义 % 和 _，
      // 否则输入中的反斜杠仍会充当转义字符。
      const escapedSearch = search.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
      // SQLite 没有 ILIKE；LOWER + LIKE 在两种数据库上均可运行。
      queryBuilder.andWhere('LOWER(user.email) LIKE LOWER(:search) ESCAPE \'\\\'', { search: `%${escapedSearch}%` });
    }

    const [users, total] = await queryBuilder.getManyAndCount();

    return { users, total };
  }

  async findOne(id: string): Promise<Partial<User>> {
    const user = await this.userRepository.findOne({
      where: { id },
      select: ['id', 'email', 'role', 'isBanned', 'emailVerified', 'lastLoginIP', 'lastLoginAt', 'createdAt'],
    });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    return user;
  }

  async create(data: { email: string; password: string; role?: UserRole }, requester: User): Promise<Partial<User>> {
    // 邮箱归一化：trim + 小写，减少大小写/空白导致的重复账户
    const email = data.email.trim().toLowerCase();

    // G6-10：用 withDeleted(true) 检查邮箱，避免「已软删用户占用邮箱」导致的死锁。
    // email 唯一约束包含软删行，而默认 findOne 会排除软删用户；若某邮箱被已删除用户占用，
    // 直接创建会命中唯一约束（23505），用户看到无法解释的「已注册」。
    // 这里显式查出含软删的占用者：若命中已软删用户，明确提示可重新激活而非含糊的冲突。
    const existingUser = await this.userRepository.findOne({
      where: { email },
      withDeleted: true,
    });

    if (existingUser) {
      if (existingUser.deletedAt) {
        throw new ConflictException('该邮箱曾注册且已被删除，如需使用请联系管理员重新激活该账户');
      }
      throw new ConflictException('该邮箱已被注册');
    }

    // 强制角色控制：admin 只能创建 USER，super_admin 可以创建 admin 但不能创建另一个 super_admin
    let role: UserRole;
    if (requester.role === UserRole.SUPER_ADMIN && data.role === UserRole.ADMIN) {
      role = UserRole.ADMIN;
    } else {
      role = UserRole.USER;
    }

    const hashedPassword = await bcrypt.hash(data.password, BCRYPT_ROUNDS);

    const user = this.userRepository.create({
      email,
      password: hashedPassword,
      role,
      emailVerified: true,
    });

    try {
      await this.userRepository.save(user);
    } catch (error) {
      // TOCTOU：并发下同邮箱可能在 findOne 之后、save 之前被插入，
      // 命中唯一约束（23505）时转为 409，避免未捕获 500。
      if ((error as { code?: string })?.code === '23505') {
        throw new ConflictException('该邮箱已被注册');
      }
      throw error;
    }

    // 审计日志：管理员创建用户
    this.auditService.log({
      action: 'user_create',
      userId: requester.id,
      resourceType: 'user',
      resourceId: user.id,
      metadata: { email: user.email, role: user.role },
    });

    return {
      id: user.id,
      email: user.email,
      role: user.role,
    };
  }

  async delete(id: string, requester: User): Promise<void> {
    // B-3: 防止管理员删除自己
    if (requester.id === id) {
      throw new BadRequestException('无法删除自己的账户');
    }

    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      const user = await queryRunner.manager.findOne(User, { where: { id } });

      if (!user) {
        throw new NotFoundException('用户不存在');
      }

      if (user.role === UserRole.SUPER_ADMIN) {
        throw new BadRequestException('无法删除超级管理员');
      }

      // 权限提升防护：普通 ADMIN 不能删除其他 ADMIN，仅 SUPER_ADMIN 可以
      if (user.role === UserRole.ADMIN && requester.role !== UserRole.SUPER_ADMIN) {
        throw new ForbiddenException('无权删除其他管理员');
      }

      // 事务内：软删除用户的所有文件
      // 删除用户时隔离其文件，并统一设置明确的 7 天删除计划。
      const now = new Date();
      const scheduledAt = new Date(now.getTime() + FILE_DELETE_GRACE_MS);
      await queryRunner.manager.update(
        File,
        { uploaderId: id, isDeleted: false },
        {
          isDeleted: true,
          deletedByAdmin: true,
          deleteRequestedAt: now,
          deleteScheduledAt: scheduledAt,
        },
      );

      // 事务内：级联软删除该用户的全部文件夹（与文件同一删除计划），
      // 避免删除用户后 folders 行永久残留（isDeleted 仍 false 且无归属清理）。
      await queryRunner.manager.update(
        Folder,
        { ownerId: id, isDeleted: false },
        {
          isDeleted: true,
          deleteRequestedAt: now,
          deleteScheduledAt: scheduledAt,
        },
      );

      // 事务内：吊销该用户的全部 ShareLink，使宽限期内也无法匿名访问已删用户数据。
      // 置 isDeleted + DISABLED，与「取消分享」语义一致。
      await queryRunner.manager.update(
        ShareLink,
        { creatorId: id, isDeleted: false },
        { isDeleted: true, status: ShareLinkStatus.DISABLED },
      );

      // 事务内：物理删除该用户的全部 Tag（Tag 无 isDeleted/延迟删除字段）。
      await queryRunner.manager.delete(Tag, { userId: id });

      // 事务内：软删除用户（保留用户行）。
      // 不能硬删除：files.uploaderId → users.id 外键无 ON DELETE 策略，
      // 硬删除有文件的用户会因外键约束恒失败（500）。软删除设置 deletedAt，
      // TypeORM 常规查询会自动排除已软删除用户，从而禁止其登录与被检索。
      await queryRunner.manager.softDelete(User, { id });

      await queryRunner.commitTransaction();

      // 审计日志：删除用户（高敏感操作，等待写入完成）
      await this.auditService.logAwait({
        action: 'user_delete',
        userId: requester.id,
        resourceType: 'user',
        resourceId: id,
        metadata: { email: user.email },
      });
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async updateRole(id: string, role: UserRole, requester: User): Promise<void> {
    if (requester.role !== UserRole.SUPER_ADMIN) {
      throw new BadRequestException('只有超级管理员可以修改用户角色');
    }

    // G6-09：禁止修改自己的角色（防止 super_admin 把自己降级为 admin/user 导致
    // 平台失去最高权限，或操作者自锁死）。目标必须是他人。
    if (requester.id === id) {
      throw new BadRequestException('不能修改自己的角色');
    }

    if (role === UserRole.SUPER_ADMIN) {
      throw new BadRequestException('不能通过接口创建超级管理员');
    }

    const user = await this.userRepository.findOne({ where: { id } });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    if (user.role === UserRole.SUPER_ADMIN) {
      throw new BadRequestException('无法修改超级管理员角色');
    }

    // G6-09：不得降级最后一个 SUPER_ADMIN。
    // 目标本身非 super_admin，此校验作为纵深防御：若系统中已无其他 super_admin
    // （仅剩 requester），任何可能削减最高权限角色的操作都不可接受。
    if (requester.role === UserRole.SUPER_ADMIN) {
      const superAdminCount = await this.userRepository.count({
        where: { role: UserRole.SUPER_ADMIN },
      });
      if (superAdminCount <= 1) {
        throw new BadRequestException('系统至少需保留一个超级管理员，无法执行此操作');
      }
    }

    await this.userRepository.update(id, { role });

    // 审计日志：角色变更（高敏感操作，记录操作者并等待写入完成）
    await this.auditService.logAwait({
      action: 'role_change',
      userId: requester.id,
      resourceType: 'user',
      resourceId: id,
      metadata: { previousRole: user.role, newRole: role },
    });
  }

  async banUser(id: string, isBanned: boolean, requester: User): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id } });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    if (user.role === UserRole.SUPER_ADMIN) {
      throw new BadRequestException('无法封禁超级管理员');
    }

    // 权限提升防护：普通 ADMIN 不能封禁其他 ADMIN，仅 SUPER_ADMIN 可以
    if (user.role === UserRole.ADMIN && requester.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('无权封禁其他管理员');
    }

    await this.userRepository.update(id, { isBanned });

    // 审计日志：用户封禁/解封（高敏感操作，记录操作者并等待写入完成）
    await this.auditService.logAwait({
      action: isBanned ? 'user_ban' : 'user_unban',
      userId: requester.id,
      resourceType: 'user',
      resourceId: id,
    });
  }

  async changePassword(id: string, oldPassword: string, newPassword: string): Promise<void> {
    // B-2: 新密码不能与旧密码相同
    if (newPassword === oldPassword) {
      throw new BadRequestException('新密码不能与旧密码相同');
    }

    const user = await this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('user.id = :id', { id })
      .getOne();

    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    const isOldPasswordValid = await bcrypt.compare(oldPassword, user.password);
    if (!isOldPasswordValid) {
      throw new BadRequestException('原密码错误');
    }

    const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // 同步更新 passwordUpdatedAt：该字段用于 JWT 吊销检测，
    // 改密后使旧 token 失效（如账号被盗后改密可立即踢下旧会话）。
    await this.userRepository.update(id, {
      password: hashedPassword,
      passwordUpdatedAt: new Date(),
    });

    // 审计日志：密码变更
    this.auditService.log({
      action: 'password_reset',
      userId: id,
      resourceType: 'user',
      resourceId: id,
    });
  }

  async getUserStats(userId: string): Promise<{ fileCount: number; totalSize: number; totalAccessCount: number }> {
    const [fileStats, accessStats] = await Promise.all([
      this.fileRepository
        .createQueryBuilder('file')
        .select([
          'COUNT(*) as "fileCount"',
          'COALESCE(SUM(file.size), 0) as "totalSize"',
        ])
        .where('file.uploaderId = :userId', { userId })
        .andWhere('file.isDeleted = false')
        .getRawMany(),
      this.accessLogRepository
        .createQueryBuilder('log')
        .select('COUNT(*) as "count"')
        .where('log.uploaderId = :userId', { userId })
        .getRawMany(),
    ]);

    return {
      fileCount: Number(fileStats[0]?.fileCount || 0),
      totalSize: Number(fileStats[0]?.totalSize || 0),
      totalAccessCount: Number(accessStats[0]?.count || 0),
    };
  }
}
