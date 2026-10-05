import { Injectable, Logger } from '@nestjs/common';
import { TelegramAccountFeatureService } from '../telegram-accounts/telegram-account-feature.service';
import { FileCopyService } from '../telegram-account-pool/file-copy.service';
import { ReplicaTargetResolver } from '../telegram-account-pool/replica-target.resolver';
import { TelegramMirrorSourceService } from './telegram-mirror-source.service';
import { TelegramMirrorTriggerService } from './telegram-mirror-trigger.service';

/**
 * 同一文件的懒触发冷却窗口。
 *
 * 为什么与轮次合并窗口同量级（15 分钟）：下载是高频动作，若每次下载都查副本表，
 * 大文件被多人反复下载时会把「下载链路」拖进无意义的重复查询；15 分钟足以覆盖
 * 一次补齐动作的完整周期（建单 → 主群搬运 → 中继 → 镜像群认领 → 副本桥接）。
 */
export const LAZY_TRIGGER_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * 冷却表容量上限（单实例内存治理）。
 *
 * 单后端实例是本项目的硬约束（见部署预检），因此进程内 Map 是既有范式
 * （分片上传会话、缩略图去重、缓存 single-flight 同法）；容量上限 + 过期淘汰
 * 保证「下载过的文件很多」时内存不随文件数无界增长。
 */
export const LAZY_TRIGGER_MAX_ENTRIES = 1000;

/**
 * 下载期懒触发补扩散（老文件副本补齐）。
 *
 * 定位：**只补建镜像任务，不执行任何扩散动作**。真正的扩散仍由镜像任务队列承担
 * （主群 → 用户账号中继 → 各镜像群 → 各 Bot 登记自己的 `file_id` 副本），
 * 因此本服务不引入第二条执行路径，也不产生任何文件字节的二次传输。
 *
 * 触发条件（全部满足）：
 * 1. 镜像功能总开关开启、账号池生效（`desiredReplicas()` 有值）；
 * 2. 该站内文件的 ready 副本账号数 < 有效目标副本数；
 * 3. 源锚点可定位（主记录 `telegramChatId/telegramMessageId`，缺失时由
 *    `TelegramMirrorSourceService` 用**同归属**的 ready 副本锚点兜底）。
 *
 * 安全与幂等：
 * - 终态任务（`succeeded` / `failed` / `blocked` / `cancelled`）一律不重开：只走
 *   `TelegramMirrorTriggerService.onFileCommitted` → `enqueue()` 的既有幂等语义
 *   （唯一键 `ruleId:ownerType:ownerId:sourceVersion`），**绝不调用 `requeueTerminal`**，
 *   因此 `blocked_manual` 不会随下载被自动重开（只能由管理员显式重试）；
 * - fail-open：任何异常只 warn，绝不抛出、绝不阻塞下载，也不参与下载准入/预约；
 * - 冷却：同一文件在冷却窗口内只做一次检查，并发下载只会产生一次补建尝试
 *   （建单本身还有唯一键兜底，重复投递不会产生重复备份）。
 */
@Injectable()
export class TelegramMirrorLazyTriggerService {
  private readonly logger = new Logger(TelegramMirrorLazyTriggerService.name);
  /** fileId → 冷却截止时间戳（毫秒） */
  private readonly cooldown = new Map<string, number>();
  /**
   * 正在检查中的文件（同步打标）。
   *
   * 为什么冷却表不够：冷却是在开关/目标解析（均为 await）之后才写入的，
   * 同一文件的并发下载会在那段窗口里全部越过冷却检查并各自查库；
   * 这里在**调用瞬间同步**占位，把并发收敛成一次检查，检查结束即释放
   * （因此镜像关闭 / 池未生效时不会留下冷却，重新开启后立刻恢复补扩散）。
   */
  private readonly pending = new Set<string>();

  constructor(
    private readonly feature: TelegramAccountFeatureService,
    private readonly trigger: TelegramMirrorTriggerService,
    private readonly source: TelegramMirrorSourceService,
    private readonly copies: FileCopyService,
    private readonly replicaTargets: ReplicaTargetResolver,
  ) {}

  /**
   * 下载发现副本可能不足时调用（fire-and-forget：调用方只负责「问一声」，不等结果）。
   *
   * @param ownerType 归属类型；当前只支持 `file`（站内文件），其余直接忽略
   * @param ownerId 站内文件 id
   */
  maybeTrigger(ownerType: 'file', ownerId: string): void {
    if (ownerType !== 'file') return;
    const id = (ownerId ?? '').trim();
    if (!id) return;
    if (this.isCoolingDown(id, Date.now())) return;
    if (this.pending.has(id)) return;

    this.pending.add(id);
    void this.runCheck(id)
      .catch((error: unknown) => {
        this.logger.warn(
          `下载期懒触发补扩散异常（file=${id}，不影响下载）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.pending.delete(id);
      });
  }

  /** 冷却状态快照（测试与诊断用；不参与业务判定） */
  cooldownSize(): number {
    return this.cooldown.size;
  }

  /** 在检查中的文件数快照（测试与诊断用；不参与业务判定） */
  pendingSize(): number {
    return this.pending.size;
  }

  private async runCheck(ownerId: string): Promise<void> {
    // 关闭态不打冷却：管理员重新开启后应立刻恢复补扩散能力（查询成本由开关读取承担）
    if (!(await this.feature.isMirrorEnabled())) return;

    // 池未生效 / 没有可承载副本的账号：不扩散（打冷却没有意义，池状态可能随时变化）
    const target = await this.replicaTargets.desiredReplicas();
    if (!target) return;

    // 打冷却：冷却窗口内的后续下载直接短路（并发收敛由 maybeTrigger 的 pending 占位保证）
    this.markCoolingDown(ownerId, Date.now());

    // 计数口径 = ready 副本账号数（与后台「副本覆盖率」审计同口径）：
    // 不按「当前是否可调度」过滤——冷却/停用账号持有的副本仍是既有事实，
    // 覆盖率与补建判定必须看同一个数，否则界面显示缺口而触发层认为已达标。
    const readyAccountIds = new Set(await this.copies.readyAccountIds('file', ownerId));
    if (readyAccountIds.size >= target) {
      this.logger.debug(
        `下载期懒触发跳过：副本已达标（file=${ownerId}，ready=${readyAccountIds.size}/${target}）`,
      );
      return;
    }

    // 源锚点不可定位时不建单：否则任务必然以 blocked 收口（与历史补偿同口径：宁可漏建，不拿不完整数据建单）
    const descriptor = await this.source.describe('file', ownerId);
    if (!descriptor.chatId || !descriptor.messageId) {
      this.logger.debug(
        `下载期懒触发跳过：源锚点不可定位（file=${ownerId}，主记录与同归属副本均无可用锚点）`,
      );
      return;
    }

    const created = await this.trigger.onFileCommitted(
      {
        ownerType: 'file',
        ownerId,
        sourceVersion: descriptor.sourceVersion,
        sourceAccountId: descriptor.sourceAccountId,
        sourceChatId: descriptor.chatId,
        sourceMessageId: descriptor.messageId,
      },
      'web_upload',
    );

    if (created) {
      this.logger.log(
        `下载期懒触发补扩散已建单（file=${ownerId}，ready=${readyAccountIds.size}/${target}；`
        + '仅入队由用户账号中继执行，零字节）',
      );
    } else {
      this.logger.debug(
        `下载期懒触发未产生新任务（file=${ownerId}：已有同版本任务、终态任务不重开或规则来源范围不匹配）`,
      );
    }
  }

  private isCoolingDown(ownerId: string, now: number): boolean {
    const expiresAt = this.cooldown.get(ownerId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.cooldown.delete(ownerId);
      return false;
    }
    return true;
  }

  private markCoolingDown(ownerId: string, now: number): void {
    this.pruneCoolingDown(now);
    // 先删后插：Map 迭代顺序即插入顺序，刷新过的 key 视为最新，淘汰时才不会先杀掉热点文件
    this.cooldown.delete(ownerId);
    this.cooldown.set(ownerId, now + LAZY_TRIGGER_COOLDOWN_MS);
  }

  private pruneCoolingDown(now: number): void {
    if (this.cooldown.size < LAZY_TRIGGER_MAX_ENTRIES) return;
    for (const [key, expiresAt] of this.cooldown) {
      if (expiresAt <= now) this.cooldown.delete(key);
    }
    while (this.cooldown.size >= LAZY_TRIGGER_MAX_ENTRIES) {
      const oldest = this.cooldown.keys().next();
      if (oldest.done) break;
      this.cooldown.delete(oldest.value);
    }
  }
}
