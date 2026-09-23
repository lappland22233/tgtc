import { Provider, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AlertEngineService } from '../alert/alert-engine.service';
import { TelegramMirrorTask } from '../common/entities/telegram-mirror-task.entity';
import { AuditService } from '../common/services/audit.service';
import { RateLimitService } from '../common/services/rate-limit.service';
import { StreamResponderService } from '../common/services/stream-responder.service';
import { FileCacheService } from '../file/file-cache.service';
import { AccountAwareDownloadService } from '../telegram-account-pool/account-aware-download.service';
import { FileCopyService } from '../telegram-account-pool/file-copy.service';
import { TelegramAccountClientService } from '../telegram-account-pool/telegram-account-client.service';
import { TelegramAccountPoolAlertService } from '../telegram-account-pool/telegram-account-pool-alert.service';
import { TelegramAccountPoolService } from '../telegram-account-pool/telegram-account-pool.service';
import { TelegramAccountsService } from '../telegram-accounts/telegram-accounts.service';
import { TelegramMirrorConfigService } from '../telegram-mirror/telegram-mirror-config.service';
import { TelegramMirrorSourceService } from '../telegram-mirror/telegram-mirror-source.service';
import { TelegramMirrorTriggerService } from '../telegram-mirror/telegram-mirror-trigger.service';
import { TelegramUserCopyService } from '../telegram-mirror/telegram-user-copy.service';
import { TelegramUserClientService } from '../telegram-user/telegram-user-client.service';
import { TelegramService } from '../telegram/telegram.service';
import { TelegramBotAdminController } from './telegram-bot-admin.controller';
import { TelegramBotAdminService } from './telegram-bot-admin.service';
import { TelegramBotConfigService } from './telegram-bot-config.service';
import { TelegramBotDispatchService } from './telegram-bot-dispatch.service';
import { TelegramBotGrantService } from './telegram-bot-grant.service';
import { TelegramBotPollingService } from './telegram-bot-polling.service';
import { TelegramBotPublicController } from './telegram-bot-public.controller';
import { TelegramBotQuotaService } from './telegram-bot-quota.service';
import { TelegramBotTokenCryptoService } from './telegram-bot-token-crypto.service';

/**
 * Bot 账号池副本链的**依赖装配**回归门禁（容器级）。
 *
 * 回归背景：这 5 个类的可选增强依赖原先写作 `@Optional() private readonly x: X | null = null`，
 * 但缺少显式 `@Inject(X)`。`X | null` 联合类型在运行时只会发出 `Object`，按类型拿不到
 * 服务类 token；`@Optional()` 又把解析失败静默吞成 `undefined`（再落到 `= null`），
 * 于是「账号池已启用但入站不登记副本 / 直链不池化 / 私聊搬运缺失 / 告警不落库 /
 * 诊断读不到快照」全部静默发生，且没有任何报错、不阻断启动。
 *
 * 为什么必须是容器级断言（实测判据）：
 * 1. `@Optional()` 会把解析失败变成「合法」结果，所以**容器能编译通过不能作为判据**；
 * 2. `design:paramtypes` 断言只能证明「解析不出来」（是缺陷的现状），不能证明修复生效；
 * 3. 唯一可信的判据是：把每个依赖以**它自己的服务类 token** 注册成**互不相同的** mock，
 *    再由容器实例化，逐项断言字段与预期 mock **同一引用**。
 *
 * 边界：只做内存容器装配，不启动应用、不建真实数据库 / Redis / Telegram 连接，
 * 也不改变既有「直接 new 位置构造」的用例（那些用例正是参数顺序未被改动的证据）。
 */

/** 每个依赖一个独立引用：注册后必须按同一引用被注入回来，才能证明 token 命中 */
function depMock(tag: string): Record<string, unknown> {
  return { __dep: tag };
}

/** 读取被注入的私有依赖字段（测试专用，不改变类本身的可访问性） */
function injected(instance: object, key: string): unknown {
  return (instance as unknown as Record<string, unknown>)[key];
}

/** 编译一个只装配显式 provider 的内存容器 */
function compile(providers: Provider[], controllers: Type<unknown>[] = []): Promise<TestingModule> {
  return Test.createTestingModule({ providers, controllers }).compile();
}

describe('Bot 账号池副本链：可选依赖的真实装配（容器级）', () => {
  it('TelegramBotDispatchService：6 个账号池/镜像依赖按服务类 token 注入', async () => {
    const deps = {
      telegramService: depMock('TelegramService'),
      botConfigService: depMock('TelegramBotConfigService'),
      quotaService: depMock('TelegramBotQuotaService'),
      grantService: depMock('TelegramBotGrantService'),
      adminService: depMock('TelegramBotAdminService'),
      auditService: depMock('AuditService'),
      pool: depMock('TelegramAccountPoolService'),
      copies: depMock('FileCopyService'),
      accountClient: depMock('TelegramAccountClientService'),
      configService: depMock('ConfigService'),
      mirrorTrigger: depMock('TelegramMirrorTriggerService'),
      mirrorConfig: depMock('TelegramMirrorConfigService'),
    };

    const moduleRef = await compile([
      TelegramBotDispatchService,
      { provide: TelegramService, useValue: deps.telegramService },
      { provide: TelegramBotConfigService, useValue: deps.botConfigService },
      { provide: TelegramBotQuotaService, useValue: deps.quotaService },
      { provide: TelegramBotGrantService, useValue: deps.grantService },
      { provide: TelegramBotAdminService, useValue: deps.adminService },
      { provide: AuditService, useValue: deps.auditService },
      { provide: TelegramAccountPoolService, useValue: deps.pool },
      { provide: FileCopyService, useValue: deps.copies },
      { provide: TelegramAccountClientService, useValue: deps.accountClient },
      { provide: ConfigService, useValue: deps.configService },
      { provide: TelegramMirrorTriggerService, useValue: deps.mirrorTrigger },
      { provide: TelegramMirrorConfigService, useValue: deps.mirrorConfig },
    ]);

    const service = moduleRef.get(TelegramBotDispatchService);

    // 入站副本登记与站内桥接、归档转发、镜像触发、备份群转发抑制
    expect(injected(service, 'pool')).toBe(deps.pool);
    expect(injected(service, 'copies')).toBe(deps.copies);
    expect(injected(service, 'accountClient')).toBe(deps.accountClient);
    expect(injected(service, 'configService')).toBe(deps.configService);
    expect(injected(service, 'mirrorTrigger')).toBe(deps.mirrorTrigger);
    expect(injected(service, 'mirrorConfig')).toBe(deps.mirrorConfig);
  });

  it('TelegramBotPublicController：3 个账号池依赖按服务类 token 注入', async () => {
    const deps = {
      grantService: depMock('TelegramBotGrantService'),
      telegramService: depMock('TelegramService'),
      fileCacheService: depMock('FileCacheService'),
      rateLimitService: depMock('RateLimitService'),
      streamResponder: depMock('StreamResponderService'),
      auditService: depMock('AuditService'),
      accountPoolDownload: depMock('AccountAwareDownloadService'),
      fileCopies: depMock('FileCopyService'),
      configService: depMock('ConfigService'),
    };

    const moduleRef = await compile(
      [
        { provide: TelegramBotGrantService, useValue: deps.grantService },
        { provide: TelegramService, useValue: deps.telegramService },
        { provide: FileCacheService, useValue: deps.fileCacheService },
        { provide: RateLimitService, useValue: deps.rateLimitService },
        { provide: StreamResponderService, useValue: deps.streamResponder },
        { provide: AuditService, useValue: deps.auditService },
        { provide: AccountAwareDownloadService, useValue: deps.accountPoolDownload },
        { provide: FileCopyService, useValue: deps.fileCopies },
        { provide: ConfigService, useValue: deps.configService },
      ],
      [TelegramBotPublicController],
    );

    const controller = moduleRef.get(TelegramBotPublicController);

    // Bot 直链池化回源、懒扩散、默认账号身份判定
    expect(injected(controller, 'accountPoolDownload')).toBe(deps.accountPoolDownload);
    expect(injected(controller, 'fileCopies')).toBe(deps.fileCopies);
    expect(injected(controller, 'configService')).toBe(deps.configService);
  });

  it('TelegramUserCopyService：3 个私聊搬运依赖 + 仓库 token 注入', async () => {
    const deps = {
      source: depMock('TelegramMirrorSourceService'),
      accounts: depMock('TelegramAccountsService'),
      userClient: depMock('TelegramUserClientService'),
      client: depMock('TelegramAccountClientService'),
      pool: depMock('TelegramAccountPoolService'),
      configService: depMock('ConfigService'),
      tasks: depMock('Repository<TelegramMirrorTask>'),
    };

    const moduleRef = await compile([
      TelegramUserCopyService,
      { provide: TelegramMirrorSourceService, useValue: deps.source },
      { provide: TelegramAccountsService, useValue: deps.accounts },
      { provide: TelegramUserClientService, useValue: deps.userClient },
      { provide: TelegramAccountClientService, useValue: deps.client },
      { provide: TelegramAccountPoolService, useValue: deps.pool },
      { provide: ConfigService, useValue: deps.configService },
      { provide: getRepositoryToken(TelegramMirrorTask), useValue: deps.tasks },
    ]);

    const service = moduleRef.get(TelegramUserCopyService);

    // 私聊来源搬运到中转群的三个前置能力（缺一即整体 blocked）
    expect(injected(service, 'client')).toBe(deps.client);
    expect(injected(service, 'pool')).toBe(deps.pool);
    expect(injected(service, 'configService')).toBe(deps.configService);
    // 锚点写回任务行
    expect(injected(service, 'tasks')).toBe(deps.tasks);
  });

  it('TelegramAccountPoolAlertService：告警引擎按服务类 token 注入', async () => {
    const pool = depMock('TelegramAccountPoolService');
    const alertEngine = depMock('AlertEngineService');

    const moduleRef = await compile([
      TelegramAccountPoolAlertService,
      { provide: TelegramAccountPoolService, useValue: pool },
      { provide: AlertEngineService, useValue: alertEngine },
    ]);

    const service = moduleRef.get(TelegramAccountPoolAlertService);

    // 缺失时告警只写日志、永不落库
    expect(injected(service, 'alertEngine')).toBe(alertEngine);
  });

  it('TelegramBotAdminController：2 个诊断依赖按服务类 token 注入', async () => {
    const deps = {
      botConfigService: depMock('TelegramBotConfigService'),
      botAdminService: depMock('TelegramBotAdminService'),
      tokenCryptoService: depMock('TelegramBotTokenCryptoService'),
      auditService: depMock('AuditService'),
      accountPool: depMock('TelegramAccountPoolService'),
      polling: depMock('TelegramBotPollingService'),
    };

    const moduleRef = await compile(
      [
        { provide: TelegramBotConfigService, useValue: deps.botConfigService },
        { provide: TelegramBotAdminService, useValue: deps.botAdminService },
        { provide: TelegramBotTokenCryptoService, useValue: deps.tokenCryptoService },
        { provide: AuditService, useValue: deps.auditService },
        { provide: TelegramAccountPoolService, useValue: deps.accountPool },
        { provide: TelegramBotPollingService, useValue: deps.polling },
      ],
      [TelegramBotAdminController],
    );

    const controller = moduleRef.get(TelegramBotAdminController);

    // 两个只读诊断端点必须读到真实快照
    expect(injected(controller, 'accountPool')).toBe(deps.accountPool);
    expect(injected(controller, 'polling')).toBe(deps.polling);
  });
});

describe('Bot 账号池副本链：依赖确实未注册时仍降级（单账号模式行为不变）', () => {
  /**
   * `@Optional()` 的契约：增强能力未装配时字段为 `null`、不抛错、不阻断启动。
   * 这里刻意**不注册**可选依赖，证明「可降级」不是靠错误吞掉，而是契约本身。
   */
  it('TelegramBotDispatchService：账号池/镜像依赖缺失时全部为 null', async () => {
    const moduleRef = await compile([
      TelegramBotDispatchService,
      { provide: TelegramService, useValue: depMock('TelegramService') },
      { provide: TelegramBotConfigService, useValue: depMock('TelegramBotConfigService') },
      { provide: TelegramBotQuotaService, useValue: depMock('TelegramBotQuotaService') },
      { provide: TelegramBotGrantService, useValue: depMock('TelegramBotGrantService') },
      { provide: TelegramBotAdminService, useValue: depMock('TelegramBotAdminService') },
      { provide: AuditService, useValue: depMock('AuditService') },
    ]);

    const service = moduleRef.get(TelegramBotDispatchService);

    expect(injected(service, 'pool')).toBeNull();
    expect(injected(service, 'copies')).toBeNull();
    expect(injected(service, 'accountClient')).toBeNull();
    expect(injected(service, 'configService')).toBeNull();
    expect(injected(service, 'mirrorTrigger')).toBeNull();
    expect(injected(service, 'mirrorConfig')).toBeNull();
  });

  it('TelegramBotPublicController：账号池依赖缺失时全部为 null', async () => {
    const moduleRef = await compile(
      [
        { provide: TelegramBotGrantService, useValue: depMock('TelegramBotGrantService') },
        { provide: TelegramService, useValue: depMock('TelegramService') },
        { provide: FileCacheService, useValue: depMock('FileCacheService') },
        { provide: RateLimitService, useValue: depMock('RateLimitService') },
        { provide: StreamResponderService, useValue: depMock('StreamResponderService') },
        { provide: AuditService, useValue: depMock('AuditService') },
      ],
      [TelegramBotPublicController],
    );

    const controller = moduleRef.get(TelegramBotPublicController);

    expect(injected(controller, 'accountPoolDownload')).toBeNull();
    expect(injected(controller, 'fileCopies')).toBeNull();
    expect(injected(controller, 'configService')).toBeNull();
  });

  it('TelegramUserCopyService：私聊搬运依赖缺失时全部为 null（可诊断 blocked）', async () => {
    const moduleRef = await compile([
      TelegramUserCopyService,
      { provide: TelegramMirrorSourceService, useValue: depMock('TelegramMirrorSourceService') },
      { provide: TelegramAccountsService, useValue: depMock('TelegramAccountsService') },
      { provide: TelegramUserClientService, useValue: depMock('TelegramUserClientService') },
    ]);

    const service = moduleRef.get(TelegramUserCopyService);

    expect(injected(service, 'client')).toBeNull();
    expect(injected(service, 'pool')).toBeNull();
    expect(injected(service, 'configService')).toBeNull();
    expect(injected(service, 'tasks')).toBeNull();
  });

  it('TelegramAccountPoolAlertService：告警引擎缺失时为 null 且不影响主链路', async () => {
    const moduleRef = await compile([
      TelegramAccountPoolAlertService,
      { provide: TelegramAccountPoolService, useValue: depMock('TelegramAccountPoolService') },
    ]);

    const service = moduleRef.get(TelegramAccountPoolAlertService);

    expect(injected(service, 'alertEngine')).toBeNull();
  });

  it('TelegramBotAdminController：诊断依赖缺失时返回明确原因而非真实快照', async () => {
    const moduleRef = await compile(
      [
        { provide: TelegramBotConfigService, useValue: depMock('TelegramBotConfigService') },
        { provide: TelegramBotAdminService, useValue: depMock('TelegramBotAdminService') },
        { provide: TelegramBotTokenCryptoService, useValue: depMock('TelegramBotTokenCryptoService') },
        { provide: AuditService, useValue: depMock('AuditService') },
      ],
      [TelegramBotAdminController],
    );

    const controller = moduleRef.get(TelegramBotAdminController);

    expect(injected(controller, 'accountPool')).toBeNull();
    expect(injected(controller, 'polling')).toBeNull();
  });
});
