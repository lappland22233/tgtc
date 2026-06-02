import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User, UserRole } from '../common/entities/user.entity';
import { File } from '../common/entities/file.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(File)
    private fileRepository: Repository<File>,
    @InjectRepository(FileAccessLog)
    private accessLogRepository: Repository<FileAccessLog>,
  ) {}

  async findAll(page = 1, limit = 20, search?: string): Promise<{ users: Partial<User>[]; total: number }> {
    const queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .select(['user.id', 'user.email', 'user.role', 'user.isBanned', 'user.emailVerified', 'user.lastLoginIP', 'user.lastLoginAt', 'user.createdAt'])
      .skip((page - 1) * limit)
      .take(limit)
      .orderBy('user.createdAt', 'DESC');

    if (search) {
      queryBuilder.where('user.email ILIKE :search', { search: `%${search}%` });
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
    const existingUser = await this.userRepository.findOne({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new BadRequestException('该邮箱已被注册');
    }

    // 强制角色控制：admin 只能创建 USER，super_admin 可以创建 admin 但不能创建另一个 super_admin
    let role: UserRole;
    if (requester.role === UserRole.SUPER_ADMIN && data.role === UserRole.ADMIN) {
      role = UserRole.ADMIN;
    } else {
      role = UserRole.USER;
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    const user = this.userRepository.create({
      email: data.email,
      password: hashedPassword,
      role,
      emailVerified: true,
    });

    await this.userRepository.save(user);

    return {
      id: user.id,
      email: user.email,
      role: user.role,
    };
  }

  async delete(id: string): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id } });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    if (user.role === UserRole.SUPER_ADMIN) {
      throw new BadRequestException('无法删除超级管理员');
    }

    // 软删除该用户上传的所有文件（保留外键完整性，不破坏 file_access_logs 等关联数据）
    await this.fileRepository.update(
      { uploaderId: id, isDeleted: false },
      { isDeleted: true },
    );

    await this.userRepository.delete(id);
  }

  async updateRole(id: string, role: UserRole, requesterRole: UserRole): Promise<void> {
    if (requesterRole !== UserRole.SUPER_ADMIN) {
      throw new BadRequestException('只有超级管理员可以修改用户角色');
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

    await this.userRepository.update(id, { role });
  }

  async banUser(id: string, isBanned: boolean): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id } });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    if (user.role === UserRole.SUPER_ADMIN) {
      throw new BadRequestException('无法封禁超级管理员');
    }

    await this.userRepository.update(id, { isBanned });
  }

  async changePassword(id: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id } });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    const isOldPasswordValid = await bcrypt.compare(oldPassword, user.password);
    if (!isOldPasswordValid) {
      throw new BadRequestException('原密码错误');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.userRepository.update(id, { password: hashedPassword });
  }

  async getUserStats(userId: string): Promise<{ fileCount: number; totalSize: number; totalAccessCount: number }> {
    const [fileStats] = await this.fileRepository
      .createQueryBuilder('file')
      .select([
        'COUNT(*) as "fileCount"',
        'COALESCE(SUM(file.size), 0) as "totalSize"',
      ])
      .where('file.uploaderId = :userId', { userId })
      .andWhere('file.isDeleted = false')
      .getRawMany();

    const [accessStats] = await this.accessLogRepository
      .createQueryBuilder('log')
      .select('COUNT(*) as "count"')
      .where('log.uploaderId = :userId', { userId })
      .getRawMany();

    return {
      fileCount: Number(fileStats?.fileCount || 0),
      totalSize: Number(fileStats?.totalSize || 0),
      totalAccessCount: Number(accessStats?.count || 0),
    };
  }
}
