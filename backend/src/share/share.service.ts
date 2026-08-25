import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, TreeRepository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { Readable } from 'stream';
import { ShareLink, ShareTargetType, ShareLinkStatus } from '../common/entities/share-link.entity';
import { File } from '../common/entities/file.entity';
import { Folder } from '../common/entities/folder.entity';
import { AuditService } from '../common/services/audit.service';
import { AuditAction, AuditStatus } from '../common/entities/audit-log.entity';
import { FileService } from '../file/file.service';
import { SharePasswordService } from './share-password.service';
import { SharePreviewSessionService } from './share-preview-session.service';
import { ShareFolderBrowseService, computeShareExpiry } from './share-folder-browse.service';
import { CreateShareDto, UpdateShareDto } from './share.dto';
import { BCRYPT_ROUNDS } from '../common/constants/bcrypt';

const SHARE_TOKEN_BYTES = 9; // 12 字符 base64url，熵 ~72 bit

/**
 * 分享链接服务（Phase 2 核心实现）。
 *
 * 核心接口：
 * - createShare(creatorId, dto)            创建分享，返回 { token, url }
 * - getSharePublicInfo(token, accessJwt)   公开入口，返回元数据（不返回字节）
 * - verifyPassword(token, password, ip)    密码验证，返回 5 分钟 access JWT
 * - getShareDownloadStream(...)             校验后返回文件流
 *
 * 严格模式密码保护关键设计：
 * getSharePublicInfo 在 link.password != null && !accessJwt 时
 * **不查询 target 表**，直接返回 { requiresPassword: true }，
 * 杜绝元数据泄露（即使文件名都不会暴露）。
 */
@Injectable()
export class ShareService {
  constructor(
    @InjectRepository(ShareLink)
    private readonly shareLinkRepo: Repository<ShareLink>,
    @InjectRepository(File)
    private readonly fileRepo: Repository<File>,
    @InjectRepository(Folder)
    private readonly folderRepo: TreeRepository<Folder>,
    private readonly audit: AuditService,
    private readonly passwordService: SharePasswordService,
    private readonly fileService: FileService,
    private readonly configService: ConfigService,
    private readonly previewSessionService: SharePreviewSessionService,
    private readonly folderBrowse: ShareFolderBrowseService,
  ) {}

  private get appUrl(): string {
    return this.configService.get<string>('APP_URL') || 'http://localhost:3000';
  }

  /**
   * 审计脱敏：分享 token 是匿名访问凭证（尤其无密码分享），明文入库审计
   * 会导致审计库泄漏即暴露访问凭证。仅保留前 4 位前缀用于关联排查，
   * 无法据此还原完整 token（剩余部分熵不可推断）。
   */
  private maskToken(token: string): string {
    return token.slice(0, 4);
  }

  // ---------- 创建分享 ----------

  async createShare(creatorId: string, dto: CreateShareDto): Promise<{ token: string; url: string; id: string }> {
    // 1. 校验 target 存在且属于 creator
    if (dto.targetType === ShareTargetType.FILE) {
      const file = await this.fileRepo.findOne({
        where: { id: dto.targetId, uploaderId: creatorId, isDeleted: false },
      });
      if (!file) throw new NotFoundException('文件不存在或无权分享');
    } else {
      const folder = await this.folderRepo.findOne({
        where: { id: dto.targetId, ownerId: creatorId, isDeleted: false },
      });
      if (!folder) throw new NotFoundException('文件夹不存在或无权分享');
    }

    // 2. 生成唯一 token（带重试，防碰撞）
    let token: string;
    let attempt = 0;
    while (true) {
      token = randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
      // 仅当查询成功且无结果时才视为可用；DB 错误向上抛出，不误判为"可用"
      const exists = await this.shareLinkRepo.findOne({ where: { token } });
      if (!exists) break;
      attempt++;
      if (attempt >= 5) throw new BadRequestException('token 生成失败，请重试');
    }

    // 3. bcrypt 加密密码（统一使用全局 BCRYPT_ROUNDS，避免轮数硬编码不一致）
    const password = dto.password
      ? await bcrypt.hash(dto.password, BCRYPT_ROUNDS)
      : null;

    // 4. 创建 ShareLink
    const link = this.shareLinkRepo.create({
      token,
      targetType: dto.targetType as ShareTargetType,
      targetId: dto.targetId,
      creatorId,
      password,
      maxAccessCount: dto.maxAccessCount ?? -1,
      expiresIn: dto.expiresIn ?? null,
      expiresStartAt: null, // 首次访问时才设置
    });
    const saved = await this.shareLinkRepo.save(link);

    this.audit.log({
      action: 'share_link_create' as AuditAction,
      userId: creatorId,
      resourceType: 'share_link',
      resourceId: saved.id,
      metadata: { tokenPrefix: this.maskToken(token), targetType: dto.targetType, targetId: dto.targetId, hasPassword: !!password },
    });

    return { token, url: `${this.appUrl}/s/${token}`, id: saved.id };
  }

  // ---------- 公开入口 ----------

  /**
   * 公开访问入口：返回分享元数据，**不返回文件字节**。
   *
   * 严格模式密码保护关键路径：
   * - link.password != null && !accessJwt → 返回 { requiresPassword: true }
   *   **不查询 target 表**，前端无法从响应里推断文件/文件夹的任何信息。
   * - link.password != null && accessJwt → 校验 accessJwt，通过后才返回元数据。
   * - link.password == null → 直接返回元数据。
   */
  async getSharePublicInfo(token: string, accessJwt?: string) {
    const link = await this.shareLinkRepo.findOne({
      where: { token, isDeleted: false },
    });
    if (!link) throw new NotFoundException('分享不存在或已被取消');

    // 状态校验：过期/次数耗尽/取消
    await this.assertShareUsable(link);

    // 严格模式：需要密码但未通过 → 不查询 target
    if (link.password && !accessJwt) {
      return { requiresPassword: true };
    }
    if (link.password && accessJwt) {
      const ok = await this.passwordService.verifyAccessJwt(accessJwt, link.id, link.password);
      if (!ok) return { requiresPassword: true };
    }

    // 元数据探测不消费访问次数，避免 maxAccessCount=1 时页面信息请求先耗尽额度、
    // 随后的首次下载立即失败。实际下载/文件夹浏览入口会原子消费额度。
    this.audit.log({
      action: 'share_link_access' as AuditAction,
      resourceType: 'share_link',
      resourceId: link.id,
      metadata: { tokenPrefix: this.maskToken(token), targetType: link.targetType },
    });

    // 返回 target 元数据（不返回字节）
    if (link.targetType === ShareTargetType.FILE) {
      return await this.getFileInfoForShare(link);
    } else {
      return await this.folderBrowse.getFolderInfoForShare(link);
    }
  }

  // ---------- 密码验证 ----------

  /**
   * 验证分享链接密码，签发 5 分钟 access JWT。
   * - IP 失败 5 次触发封禁（复用 BannedIP 表，与 file.service 共享）
   * - 成功后返回 accessJwt，前端保存到内存，后续调用 /s/:token/download 时附带
   */
  async verifyPassword(token: string, password: string, ip: string | null): Promise<{ accessJwt: string }> {
    const precheckAllowed = await this.passwordService.checkPasswordAttemptAllowed(ip, token);
    if (!precheckAllowed) {
      throw new BadRequestException('无法验证分享密码，请稍后重试');
    }

    const link = await this.shareLinkRepo.findOne({ where: { token, isDeleted: false } });
    if (!link) throw new BadRequestException('无法验证分享密码');

    // G5-11：过期/次数耗尽的分享不允许继续验证密码。
    // 必须在 bcrypt 之前完成可用性校验，避免对已失效分享浪费昂贵哈希计算，
    // 也避免攻击者对已失效 token 仍可探测/枚举密码。
    await this.assertShareUsable(link);

    // IP 封禁检查
    if (ip) {
      const ipCheck = await this.passwordService.isIPBanned(ip);
      if (ipCheck.banned) {
        throw new BadRequestException('无法验证分享密码，请稍后重试');
      }
    }

    // 无密码的分享不应该走这个接口
    if (!link.password) {
      throw new BadRequestException('此分享无需密码');
    }

    const valid = await bcrypt.compare(password, link.password);
    if (!valid) {
      if (ip) await this.passwordService.recordFailedAttempt(ip);
      // G5-08：token 维度失败累计锁定升级（IP 封禁可被分布式换 IP 绕过）
      await this.passwordService.recordTokenFailedAttempt(token);
      this.audit.log({
        action: 'share_link_password_failed' as AuditAction,
        resourceType: 'share_link',
        resourceId: link.id,
        status: AuditStatus.FAILURE,
        metadata: { ip: ip || null },
      });
      throw new BadRequestException('无法验证分享密码');
    }

    const accessJwt = await this.passwordService.issueAccessJwt(link.id, link.password);
    return { accessJwt };
  }

  // ---------- 文件下载 ----------

  /**
   * 获取分享下载流：校验 token + accessJwt（若有密码）+ 文件存在性，
   * 调用 FileService.getStreamForShareDownload 返回 Telegram 缓存流。
   */
  async getShareDownloadStream(
    token: string,
    fileId: string,
    accessJwt: string | undefined,
    ip: string | null,
    rangeHeader?: string,
    ifRange?: string,
  ): Promise<{
    stream: Readable;
    contentType: string;
    filename: string;
    size: number;
    isInline: boolean;
    accessLogId?: string;
    start?: number;
    end?: number;
    total?: number;
    etag?: string;
  }> {
    const link = await this.shareLinkRepo.findOne({ where: { token, isDeleted: false } });
    if (!link) throw new NotFoundException('分享不存在');

    await this.assertShareUsable(link);

    // 严格模式：密码校验
    if (link.password) {
      if (!accessJwt) {
        throw new ForbiddenException('此分享需要密码');
      }
      const ok = await this.passwordService.verifyAccessJwt(accessJwt, link.id, link.password);
      if (!ok) throw new ForbiddenException('访问凭证已失效，请重新输入密码');
    }

    // 校验 fileId 是否属于此分享的 target 子树
    await this.folderBrowse.assertFileInShare(link, fileId);
    await this.consumeShareAccess(link);

    // 记录实际下载
    this.audit.log({
      action: 'share_link_download' as AuditAction,
      resourceType: 'share_link',
      resourceId: link.id,
      metadata: { tokenPrefix: this.maskToken(token), fileId, ip: ip || null },
    });

    if (rangeHeader) {
      const rangeResult = await this.fileService.getShareDownloadStreamWithRange(
        fileId, rangeHeader, ip || undefined, ifRange,
      );
      if (rangeResult) return rangeResult;
    }
    return this.fileService.getStreamForShareDownload(fileId, ip || undefined, link.token);
  }

  /**
   * 获取分享预览流：校验链与 getShareDownloadStream 完全一致
   * （token + accessJwt（若有密码）+ fileId 归属），差异：
   * - Range 命中时不消费访问额度（视频 seek 的大量 Range 不得耗尽 maxAccessCount）。
   * - 冷资源 Range 回退全量流 / 浏览器重试等内部子请求按「逻辑访问」短期会话去重：
   *   同一分享 + 同一文件在窗口内只消费一次 maxAccessCount，避免有限次数分享
   *   被 Range 重试、连接重建等浏览器内部行为提前耗尽。
   * - 审计 action 为 'share_link_preview'。
   * 携带 rangeHeader 时优先走 FileService.getSharePreviewStreamWithRange，
   * 缓存未命中（null）或未携带 rangeHeader 时回退全量流 getStreamForShareDownload。
   */
  async getSharePreviewStream(
    token: string,
    fileId: string,
    accessJwt: string | undefined,
    ip: string | null,
    rangeHeader: string | undefined,
    visitorHash: string,
    ifRange?: string,
  ): Promise<{
    stream: Readable;
    contentType: string;
    filename: string;
    size: number;
    isInline: boolean;
    accessLogId?: string;
    start?: number;
    end?: number;
    total?: number;
    etag?: string;
  }> {
    const link = await this.shareLinkRepo.findOne({ where: { token, isDeleted: false } });
    if (!link) throw new NotFoundException('分享不存在');

    await this.assertShareUsable(link);

    // 严格模式：密码校验
    if (link.password) {
      if (!accessJwt) {
        throw new ForbiddenException('此分享需要密码');
      }
      const ok = await this.passwordService.verifyAccessJwt(accessJwt, link.id, link.password);
      if (!ok) throw new ForbiddenException('访问凭证已失效，请重新输入密码');
    }

    // 校验 fileId 是否属于此分享的 target 子树
    await this.folderBrowse.assertFileInShare(link, fileId);

    // 记录实际预览访问
    this.audit.log({
      action: 'share_link_preview' as AuditAction,
      resourceType: 'share_link',
      resourceId: link.id,
      metadata: { tokenPrefix: this.maskToken(token), fileId, ip: ip || null, isRange: !!rangeHeader },
    });

    // C-03 修复：无论 Range 命中还是回退全量流，在输出任何文件字节前完成会话确认。
    // 首次返回字节前原子扣次；同会话后续 Range/重连幂等免扣。
    await this.consumeSharePreviewAccess(link, fileId, visitorHash);

    if (rangeHeader) {
      const rangeResult = await this.fileService.getSharePreviewStreamWithRange(
        fileId, rangeHeader, ip || undefined, ifRange,
      );
      if (rangeResult) return rangeResult;
      // 仅在缓存组件明确无法提供流时才允许内部降级；非法 Range 已由 FileService 抛出 416。
    }
    return this.fileService.getStreamForShareDownload(fileId, ip || undefined, link.token);
  }

  /** 分享缩略图：完整校验分享状态、密码凭证和文件范围，但不消费访问次数。 */
  async getShareThumbnailStream(
    token: string,
    fileId: string,
    accessJwt?: string,
  ): Promise<{ stream: Readable; contentType: string }> {
    const link = await this.shareLinkRepo.findOne({ where: { token, isDeleted: false } });
    if (!link) throw new NotFoundException('分享不存在');
    await this.assertShareUsable(link);
    if (link.password) {
      if (!accessJwt) throw new ForbiddenException('此分享需要密码');
      const ok = await this.passwordService.verifyAccessJwt(accessJwt, link.id, link.password);
      if (!ok) throw new ForbiddenException('访问凭证已失效，请重新输入密码');
    }
    await this.folderBrowse.assertFileInShare(link, fileId);
    return this.fileService.getExistingMediaThumbnailStream(fileId);
  }

  /** 分享高清封面：完整校验分享状态、密码凭证和文件范围，但不消费访问次数。 */
  async getShareHdThumbnailStream(
    token: string,
    fileId: string,
    accessJwt?: string,
  ): Promise<{ stream: Readable; contentType: string }> {
    const link = await this.shareLinkRepo.findOne({ where: { token, isDeleted: false } });
    if (!link) throw new NotFoundException('分享不存在');
    await this.assertShareUsable(link);
    if (link.password) {
      if (!accessJwt) throw new ForbiddenException('此分享需要密码');
      const ok = await this.passwordService.verifyAccessJwt(accessJwt, link.id, link.password);
      if (!ok) throw new ForbiddenException('访问凭证已失效，请重新输入密码');
    }
    await this.folderBrowse.assertFileInShare(link, fileId);
    return this.fileService.getExistingHdMediaThumbnailStream(fileId);
  }

  /** 分享文件缓存状态：校验后返回是否已有正式缓存（不消费访问次数）。 */
  async getShareCacheStatus(
    token: string,
    fileId: string,
    accessJwt?: string,
  ): Promise<{ status: 'cached' | 'cold' | 'unknown'; cached: boolean }> {
    const link = await this.shareLinkRepo.findOne({ where: { token, isDeleted: false } });
    if (!link) throw new NotFoundException('分享不存在');
    await this.assertShareUsable(link);
    if (link.password) {
      if (!accessJwt) throw new ForbiddenException('此分享需要密码');
      const ok = await this.passwordService.verifyAccessJwt(accessJwt, link.id, link.password);
      if (!ok) throw new ForbiddenException('访问凭证已失效，请重新输入密码');
    }
    await this.folderBrowse.assertFileInShare(link, fileId);
    const cached = this.fileService.isFileCached(fileId);
    return { status: cached ? 'cached' : 'cold', cached };
  }

  // ---------- 列出/更新/取消分享 ----------

  /** 列出当前用户的所有分享（分页 + 可按 targetType 过滤） */
  async listMyShares(creatorId: string, options: {
    targetType?: ShareTargetType;
    page?: number;
    limit?: number;
  } = {}) {
    const page = options.page ?? 1;
    const limit = Math.min(options.limit ?? 20, 100);
    const where: Record<string, unknown> = { creatorId, isDeleted: false };
    if (options.targetType) where.targetType = options.targetType;

    const [items, total] = await this.shareLinkRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    // 不暴露 bcrypt 密码哈希，只返回 hasPassword 布尔值
    return { items: items.map((s) => this.sanitizeShareLink(s)), total, page, limit };
  }

  async getShareById(id: string, creatorId: string) {
    const link = await this.getShareByIdRaw(id, creatorId);
    return this.sanitizeShareLink(link);
  }

  /** 内部方法：返回原始 ShareLink 实体（含 password），供 update/cancel 使用 */
  private async getShareByIdRaw(id: string, creatorId: string): Promise<ShareLink> {
    const link = await this.shareLinkRepo.findOne({
      where: { id, creatorId, isDeleted: false },
    });
    if (!link) throw new NotFoundException('分享不存在');
    return link;
  }

  /** 去除 password 字段，替换为 hasPassword 布尔值 */
  private sanitizeShareLink(link: ShareLink) {
    const { password, ...rest } = link;
    return { ...rest, hasPassword: !!password };
  }

  async updateShare(id: string, creatorId: string, dto: UpdateShareDto) {
    const link = await this.getShareByIdRaw(id, creatorId);
    if (dto.password !== undefined) {
      link.password = dto.password ? await bcrypt.hash(dto.password, BCRYPT_ROUNDS) : null;
    }
    if (dto.maxAccessCount !== undefined) link.maxAccessCount = dto.maxAccessCount;
    if (dto.expiresIn !== undefined) {
      link.expiresIn = dto.expiresIn;
      // 改变有效期时重置起始时间，让新有效期立即生效
      link.expiresStartAt = dto.expiresIn ? new Date() : null;
    }

    // 调大上限/延长有效期后，将 EXPIRED/EXHAUSTED 状态复位为 ACTIVE，
    // 避免残留状态导致分享逻辑混乱（DISABLED 由用户显式取消，不复位）。
    if (link.status === ShareLinkStatus.EXPIRED || link.status === ShareLinkStatus.EXHAUSTED) {
      const stillExhausted = link.maxAccessCount >= 0 && link.currentAccessCount >= link.maxAccessCount;
      let stillExpired = false;
      if (link.expiresIn && link.expiresStartAt) {
        stillExpired = new Date() > new Date(link.expiresStartAt.getTime() + link.expiresIn * 3600 * 1000);
      }
      if (!stillExhausted && !stillExpired) {
        link.status = ShareLinkStatus.ACTIVE;
      }
    }

    const saved = await this.shareLinkRepo.save(link);

    // 审计 metadata 剔除明文密码，仅记录是否设置密码
    const auditMeta: Partial<UpdateShareDto> = { ...dto };
    delete auditMeta.password;
    this.audit.log({
      action: 'share_link_update' as AuditAction,
      userId: creatorId,
      resourceType: 'share_link',
      resourceId: id,
      metadata: { ...auditMeta, hasPassword: !!saved.password },
    });

    // 返回前去除 bcrypt 哈希，避免泄漏密码哈希
    return this.sanitizeShareLink(saved);
  }

  async cancelShare(id: string, creatorId: string): Promise<void> {
    const link = await this.getShareByIdRaw(id, creatorId);
    link.isDeleted = true;
    link.status = ShareLinkStatus.DISABLED;
    await this.shareLinkRepo.save(link);
    this.audit.log({
      action: 'share_link_delete' as AuditAction,
      userId: creatorId,
      resourceType: 'share_link',
      resourceId: id,
    });
  }

  // ---------- 内部工具 ----------

  // ---------- 公开辅助方法（供 Controller 使用，Phase 3 新增） ----------

  /** 按 token 查询分享链接（用于公开端点），不存在或已软删则抛 404 */
  async getShareLinkByToken(token: string): Promise<ShareLink> {
    const link = await this.shareLinkRepo.findOne({ where: { token, isDeleted: false } });
    if (!link) throw new NotFoundException('分享不存在或已被取消');
    return link;
  }

  /**
   * 公开的可用性校验：委托给 private assertShareUsable。
   * 对外暴露为 public 方法，供 ShareController 在 folder/contents 等端点复用。
   */
  async assertShareUsablePublic(link: ShareLink): Promise<void> {
    return this.assertShareUsable(link);
  }

  /**
   * 校验 access JWT 是否属于此 share link。
   * 严格模式：返回 false 而不抛异常，让调用方按需返回 { requiresPassword: true }。
   */
  async verifyAccessJwtForLink(link: ShareLink, accessJwt: string): Promise<boolean> {
    if (!link.password) return false;
    return this.passwordService.verifyAccessJwt(accessJwt, link.id, link.password);
  }

  /**
   * 校验分享链接是否可用：
   * - isDeleted → 已取消
   * - status === DISABLED → 已禁用
   * - expiresStartAt + expiresIn < now → 已过期
   * - maxAccessCount > 0 && currentAccessCount >= maxAccessCount → 已耗尽
   *
   * 过期/耗尽会同步更新 status 字段（弱一致，可接受）。
   */
  private async assertShareUsable(link: ShareLink): Promise<void> {
    if (link.isDeleted || link.status === ShareLinkStatus.DISABLED) {
      throw new NotFoundException('分享已取消或不可用');
    }

    // 过期检查
    if (link.expiresIn && link.expiresStartAt) {
      const expiresAt = new Date(link.expiresStartAt.getTime() + link.expiresIn * 3600 * 1000);
      if (new Date() > expiresAt) {
        if (link.status !== ShareLinkStatus.EXPIRED) {
          link.status = ShareLinkStatus.EXPIRED;
          await this.shareLinkRepo.save(link).catch(() => {});
        }
        throw new NotFoundException('分享已过期');
      }
    }

    // 次数耗尽的读侧快速拦截（仅用于下载等不递增计数的路径）。
    // 真正的原子强制在 tryIncrementAccessCount 中完成；此处只读不写，
    // 即便并发下偶发漏判，也会由递增路径的原子 UPDATE 兜底，不构成超发。
    if (link.maxAccessCount >= 0 && link.currentAccessCount >= link.maxAccessCount) {
      if (link.status !== ShareLinkStatus.EXHAUSTED) {
        link.status = ShareLinkStatus.EXHAUSTED;
        await this.shareLinkRepo.save(link).catch(() => {});
      }
      throw new NotFoundException('分享访问次数已耗尽');
    }
  }

  /**
   * 原子启动有效期时钟（仅当 expiresIn 已配置且尚未启动时）。
   * 下载与预览消费路径共用，保证「仅预览」的分享同样触发有效期，
   * 避免预览分享因 expiresStartAt 恒为 null 而永久不过期。
   * 失败（行不存在/已软删）抛 404，由调用方统一兜底。
   */
  private async startExpiryClock(link: ShareLink): Promise<void> {
    if (!link.expiresIn || link.expiresStartAt) return;
    const started = await this.shareLinkRepo
      .createQueryBuilder()
      .update(ShareLink)
      .set({ expiresStartAt: () => 'COALESCE("expiresStartAt", NOW())' })
      .where('id = :id', { id: link.id })
      .andWhere('"isDeleted" = false')
      .execute();
    if (!started.affected) throw new NotFoundException('分享不存在或已被取消');
    link.expiresStartAt = new Date();
  }

  /** 实际访问入口调用：原子启动有效期并消费一次访问额度。 */
  async consumeShareAccess(link: ShareLink): Promise<void> {
    await this.startExpiryClock(link);
    const access = await this.tryIncrementAccessCount(link);
    if (!access.allowed) {
      await this.shareLinkRepo.update(link.id, { status: ShareLinkStatus.EXHAUSTED }).catch(() => {});
      throw new NotFoundException('分享访问次数已耗尽');
    }
  }

  /**
   * 分享预览「逻辑访问」短期会话：委托给持久化 SharePreviewSessionService（C-03 修复）。
   * - 会话键 = 分享链接 + 文件 + 高熵访客标识摘要，唯一约束保证多实例原子扣次；
   * - 首次返回文件字节前原子扣减一次 maxAccessCount；
   * - 同会话后续 Range / 连接重建 / 缓存冷热切换幂等免扣；
   * - 会话过期（与 access JWT 5 分钟对齐）后再次预览视为新会话。
   *
   * 由 ShareController 在调用预览流前派生 visitorHash 并传入。
   */
  async consumeSharePreviewAccess(link: ShareLink, fileId: string, visitorHash: string): Promise<void> {
    // 与下载路径一致：首次预览消费前原子启动有效期时钟，保证仅预览的分享也会过期。
    await this.startExpiryClock(link);
    const result = await this.previewSessionService.consumePreviewAccess(link, fileId, visitorHash);
    if (result === 'exhausted') {
      await this.shareLinkRepo.update(link.id, { status: ShareLinkStatus.EXHAUSTED }).catch(() => {});
      throw new NotFoundException('分享访问次数已耗尽');
    }
  }

  /**
   * 原子地递增访问计数并强制 maxAccessCount 上限。
   *
   * 用单条带条件的 UPDATE 取代「先读后写」：
   * - maxAccessCount < 0（不限次数）：无条件 +1（仍要求行存在且未软删）。
   * - maxAccessCount >= 0：仅当 currentAccessCount < maxAccessCount 时才 +1。
   *
   * 据 affected 判定是否放行：affected === 0 表示已达上限（或行不存在/已软删），
   * 从而在并发下杜绝超发与丢失更新。写法参考 FileService.checkAndIncrementAccess。
   */
  private async tryIncrementAccessCount(link: ShareLink): Promise<{ allowed: boolean }> {
    if (link.maxAccessCount < 0) {
      // 不限次数：原子 +1，仅用于统计
      await this.shareLinkRepo
        .createQueryBuilder()
        .update(ShareLink)
        .set({ currentAccessCount: () => '"currentAccessCount" + 1' })
        .where('id = :id', { id: link.id })
        .andWhere('"isDeleted" = false')
        .execute();
      return { allowed: true };
    }

    const result = await this.shareLinkRepo
      .createQueryBuilder()
      .update(ShareLink)
      .set({ currentAccessCount: () => '"currentAccessCount" + 1' })
      .where('id = :id', { id: link.id })
      .andWhere('"isDeleted" = false')
      .andWhere('"currentAccessCount" < "maxAccessCount"')
      .execute();

    return { allowed: (result.affected ?? 0) > 0 };
  }

  /** 文件分享：返回文件元数据 + 下载 URL */
  private async getFileInfoForShare(link: ShareLink) {
    const file = await this.fileRepo.findOne({ where: { id: link.targetId, isDeleted: false } });
    if (!file) throw new NotFoundException('文件已被删除');
    const expiresAt = computeShareExpiry(link);
    return {
      requiresPassword: false,
      targetType: 'file' as const,
      fileInfo: {
        id: file.id,
        name: file.originalName,
        size: Number(file.size),
        mimeType: file.mimeType,
        createdAt: file.createdAt,
        expiresAt,
        // 覆盖上传时递增，供前端做进度记录版本校验
        uploadVersion: file.uploadVersion,
      },
      downloadUrl: `/api/s/${link.token}/download/${file.id}`,
    };
  }

  /** 转发：列出文件夹分享内容（实现位于 ShareFolderBrowseService） */
  async listFolderContentsForShare(
    link: ShareLink,
    folderId: string,
    options: { page?: number; limit?: number } = {},
  ) {
    return this.folderBrowse.listFolderContentsForShare(link, folderId, options);
  }

  /** 转发：纯校验 folderId 是否在分享子树内（G5-07，消费配额前调用） */
  async assertFolderInSharePublic(link: ShareLink, folderId: string): Promise<void> {
    return this.folderBrowse.assertFolderInShare(link, folderId);
  }

  /** 转发：返回文件夹分享面包屑（实现位于 ShareFolderBrowseService） */
  async getFolderBreadcrumbForShare(link: ShareLink, folderId: string) {
    return this.folderBrowse.getFolderBreadcrumbForShare(link, folderId);
  }
}
