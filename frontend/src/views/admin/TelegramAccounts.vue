<template>
  <div class="telegram-accounts-page">
    <div class="page-header">
      <h1>Telegram 账号池</h1>
      <p>统一管理 Bot / 用户账号、镜像备份规则与任务队列（仅超级管理员可见）</p>
    </div>

    <!-- 能力状态条：三层开关 + 前置检查 -->
    <section class="card status-card" aria-label="能力状态">
      <div class="status-switches">
        <div class="status-switch">
          <div class="status-switch-text">
            <span class="status-switch-label">账号池总开关</span>
            <span class="status-switch-meta">
              {{ featureSourceText(overview?.feature.accountPoolSource) }}
              <template v-if="overview?.feature.accountPoolForceDisabled">· 已被环境变量强制关闭</template>
            </span>
          </div>
          <t-switch
            :value="overview?.feature.accountPoolEnabled ?? false"
            :disabled="overview?.feature.accountPoolForceDisabled ?? false"
            :loading="featureSaving"
            @change="(v: boolean) => toggleAccountPool(Boolean(v))"
          />
        </div>

        <div class="status-switch">
          <div class="status-switch-text">
            <span class="status-switch-label">镜像功能总开关</span>
            <span class="status-switch-meta">
              {{ featureSourceText(overview?.feature.mirrorSource ?? mirror?.feature.source) }}
              <template v-if="overview?.feature.mirrorForceDisabled ?? mirror?.feature.forceDisabled">· 已被环境变量强制关闭</template>
            </span>
          </div>
          <t-switch
            :value="mirror?.feature.mirrorEnabled ?? false"
            :disabled="mirror?.feature.forceDisabled ?? false"
            :loading="featureSaving"
            @change="(v: boolean) => toggleMirror(Boolean(v))"
          />
        </div>
      </div>

      <div v-if="precheckFailures.length > 0" class="precheck-list">
        <t-alert theme="warning" title="前置检查未通过项">
          <ul class="precheck-items">
            <li v-for="item in precheckFailures" :key="item.id">{{ item.hint }}</li>
          </ul>
        </t-alert>
      </div>
    </section>

    <!-- 总览卡区 -->
    <section class="overview-grid" aria-label="总览">
      <div class="stat-card">
        <h3>账号总数</h3>
        <div class="value">{{ counts.total }}</div>
        <div class="stat-sub">Bot {{ counts.bot }} · 用户 {{ counts.user }}</div>
        <div class="stat-sub">
          正常 {{ counts.active }} · 降级 {{ counts.degraded }} · 停用 {{ counts.disabled }} · 撤销 {{ counts.revoked }} · 待授权 {{ counts.pendingAuth }}
        </div>
      </div>

      <div class="stat-card">
        <h3>镜像规则</h3>
        <div class="value">{{ enabledRuleCount }} / {{ mirrorRuleCount }}</div>
        <div class="stat-sub">启用 {{ enabledRuleCount }} 条 · 共 {{ mirrorRuleCount }} 条（每条启用规则一个镜像群）</div>
        <div class="stat-sub">当前主群：{{ mirror?.mainChatId || '未配置' }}</div>
      </div>

      <div class="stat-card">
        <h3>今日任务</h3>
        <div class="value">{{ tasks.todaySucceeded }}</div>
        <div class="stat-sub">成功 {{ tasks.todaySucceeded }} · 失败 {{ tasks.todayFailed }} · 阻塞 {{ tasks.todayBlocked }}</div>
        <div class="stat-sub">队列中 {{ tasks.queued }} · 执行中 {{ tasks.running }} · 重试中 {{ tasks.retrying }}</div>
      </div>

      <div class="stat-card">
        <h3>最近一次错误</h3>
        <div class="value error-value">{{ tasks.lastError?.code || '无' }}</div>
        <div class="stat-sub error-summary">{{ tasks.lastError?.summary || '暂无错误记录' }}</div>
        <div class="stat-sub">{{ formatTime(tasks.lastError?.at) }}</div>
      </div>
    </section>

    <!-- 副本扩散策略：策略状态 + 中继指标 + 大文件覆盖 + 资格审计 + 事件时间线 -->
    <section class="card" aria-label="副本扩散策略">
      <div class="section-header">
        <h3>副本扩散策略</h3>
        <div class="section-actions">
          <span v-if="replication && replicationStale" class="stale-flag">数据已过期（保留上次结果）</span>
          <span v-if="replication" class="section-hint-inline">数据生成于 {{ formatTime(replication.generatedAt) }}</span>
          <t-button
            variant="outline"
            size="small"
            :loading="preflightLoading"
            @click="runRelayPreflightCheck(true)"
          >
            能力预检（只读）
          </t-button>
          <t-button
            variant="outline"
            size="small"
            :loading="preflightLoading"
            @click="confirmPreflightWithTestMessage"
          >
            探测目标群可写
          </t-button>
          <t-button variant="outline" size="small" :loading="replicationLoading" @click="loadReplicationAudit">
            刷新审计
          </t-button>
          <t-button size="small" :loading="replicationSaving" @click="saveReplicationTarget">
            保存期望副本数
          </t-button>
        </div>
      </div>

      <t-alert
        v-if="observability.degraded"
        theme="warning"
        title="观测数据不完整"
        :message="observability.reason || '扩散轮次写入/读取失败，指标与事件可能缺失；请检查后端日志。'"
      />

      <!-- 策略状态卡：唯一策略 + 前置能力 + 探测结论 -->
      <div v-if="replication" class="replica-strategy">
        <div class="strategy-head">
          <t-tag theme="primary" variant="light">当前策略：{{ replication.strategy.label }}</t-tag>
          <span class="strategy-claim">
            链路：主群 → userbot 中继 → 镜像群 → Bot 认领。策略 A（Bot 重新上传到备份群）已移除：
            字节二次传输恒为 0，中继失败不会降级为下载/上传，缺口会持续到中继恢复。
          </span>
        </div>

        <p class="strategy-audit-note">
          扩散由「启用中的镜像规则数」驱动（每条启用规则 = 一个镜像群、各自独立任务/重试/状态）；
          <code class="cell-mono">TELEGRAM_POOL_TARGET_REPLICAS</code>
          仅为<strong>审计口径</strong>（用于覆盖率与目标解析展示），<strong>不再作为触发扩散的依据</strong>。
        </p>

        <dl class="strategy-kv">
          <div class="kv-item">
            <dt>中继开关</dt>
            <dd>
              <t-tag
                :theme="relayCapability.relayEnabledByConfig ? 'success' : 'danger'"
                variant="light"
                size="small"
              >
                {{ relayCapability.relayEnabledByConfig ? '已启用' : '未启用' }}
              </t-tag>
              <span class="kv-note">构造期读取，变更后需重启后端</span>
            </dd>
          </div>
          <div class="kv-item">
            <dt>MTProto 客户端</dt>
            <dd>
              <t-tag
                :theme="relayCapability.userClientAvailable ? 'success' : 'danger'"
                variant="light"
                size="small"
              >
                {{ relayCapability.userClientAvailable ? '可用' : '不可用' }}
              </t-tag>
              <span v-if="relayCapability.userClientUnavailableReason" class="kv-note">
                {{ relayCapability.userClientUnavailableReason }}
              </span>
            </dd>
          </div>
          <div class="kv-item">
            <dt>已授权且启用的用户账号</dt>
            <dd>
              <span class="cell-strong">{{ relayCapability.enabledAuthorizedUserCount }}</span>
              <span class="kv-note">中继选号候选池</span>
            </dd>
          </div>
          <div class="kv-item">
            <dt>用户账号中继成功</dt>
            <dd>
              <span class="cell-strong">{{ mirror?.metrics.userCopyCount ?? 0 }}</span>
              <span class="kv-note">服务端中继计数（进程内，单实例）；字节二次传输恒为 0</span>
            </dd>
          </div>
          <div class="kv-item">
            <dt>目标群（副本可见群）</dt>
            <dd>
              <span v-if="relayCapability.resolvedTargetChatIdPreview" class="cell-mono">
                {{ relayCapability.resolvedTargetChatIdPreview }}
              </span>
              <span v-else class="replica-warn">未解析到目标群（需启用中的镜像规则）</span>
            </dd>
          </div>
          <div class="kv-item">
            <dt>最近能力检查</dt>
            <dd>
              <span v-if="relayCapability.checkedAt">
                {{ formatTime(relayCapability.checkedAt) }} · {{ capabilityStatusText }}
              </span>
              <span v-else class="cell-muted">未检查</span>
            </dd>
          </div>
        </dl>

        <div class="check-badges">
          <span class="check-badge" :class="relayCheckClass(relayCapability.sourceChatReadable)">
            源群可读：{{ relayCheckText(relayCapability.sourceChatReadable) }}
          </span>
          <span class="check-badge" :class="relayCheckClass(relayCapability.targetChatWritable)">
            目标群可写：{{ relayCheckText(relayCapability.targetChatWritable) }}
          </span>
          <span class="check-badge" :class="relayCheckClass(relayCapability.botsCanReceiveRelay)">
            Bot 可接收中继消息：{{ relayCheckText(relayCapability.botsCanReceiveRelay) }}
          </span>
        </div>

        <ul v-if="relayCapability.notes.length > 0" class="strategy-blockers">
          <li v-for="note in relayCapability.notes" :key="note">{{ note }}</li>
        </ul>

        <div v-if="preflightReport" class="preflight-report">
          <div class="preflight-head">
            <t-tag
              :theme="preflightReport.status === 'ok' ? 'success' : preflightReport.status === 'partial' ? 'warning' : 'danger'"
              variant="light"
              size="small"
            >
              预检{{ preflightStatusText(preflightReport.status) }}
            </t-tag>
            <span class="kv-note">
              {{ preflightReport.dryRun
                ? '只读检查：未产生任何 Telegram 消息'
                : preflightReport.sentTestMessage
                  ? '已产生一条 Telegram 测试消息'
                  : '未发出测试消息' }}
              · {{ formatTime(preflightReport.checkedAt) }}
            </span>
          </div>
          <ul class="preflight-checks">
            <li v-for="check in preflightReport.checks" :key="check.id" class="preflight-check">
              <span class="check-badge" :class="relayCheckClass(check.status)">{{ relayCheckText(check.status) }}</span>
              <span class="cell-strong">{{ check.label }}</span>
              <span class="kv-note">{{ check.detail }}</span>
              <span v-if="check.advice" class="replica-warn">建议：{{ check.advice }}</span>
            </li>
          </ul>
        </div>
      </div>

      <div v-if="replication" class="replica-grid">
        <div class="stat-card">
          <h3>期望副本数（审计口径）</h3>
          <div class="replica-input">
            <t-input-number
              v-model="replicationForm.desiredReplicas"
              :min="replication.target.allowedRange.min"
              :max="replication.target.allowedRange.max"
              :step="1"
              size="small"
            />
          </div>
          <div class="stat-sub">
            仅用于覆盖率审计，不再驱动扩散：扩散目标由启用中的镜像规则数决定
          </div>
          <div class="stat-sub">
            来源：{{ targetSourceText(replication.target.configuredSource) }} · 可承载账号 {{ replication.target.eligibleCount }} 个
          </div>
          <div class="stat-sub">有效目标 {{ replication.target.effectiveTarget }} 路（按可承载账号数收敛）</div>
          <div v-if="replication.target.degradedReason" class="stat-sub replica-warn">
            {{ replication.target.degradedReason }}
          </div>
        </div>

        <div class="stat-card">
          <h3>全局权重预算</h3>
          <div class="value">{{ capacity?.currentBudget ?? '—' }}</div>
          <div class="stat-sub">
            自动扩缩容：{{ capacity?.enabled ? '已开启' : '已关闭' }} · 目标预算 {{ capacity?.targetBudget ?? '—' }}
          </div>
          <div class="stat-sub">
            有效 Bot 数 {{ capacity?.activeBotCount ?? 0 }} · 可承载账号 {{ capacity?.eligibleCount ?? 0 }}
          </div>
          <div v-if="capacity?.suspendedReason" class="stat-sub replica-warn">{{ capacity.suspendedReason }}</div>
          <div v-else-if="capacity?.frozenReason" class="stat-sub replica-warn">{{ capacity.frozenReason }}</div>
          <div v-if="capacity?.lastChange" class="stat-sub">
            最近调整 {{ capacity.lastChange.from }} → {{ capacity.lastChange.to }}
            · {{ formatTime(capacity.lastChange.at) }}
          </div>
        </div>

        <div class="stat-card">
          <h3>副本覆盖率</h3>
          <div class="value">{{ coverage.satisfied }} / {{ coverage.scannedFiles }}</div>
          <div class="stat-sub">未达标 {{ coverage.unsatisfied }} 个文件（目标 {{ replication.target.effectiveTarget }} 路）</div>
          <div v-if="coverage.truncated" class="stat-sub replica-warn">统计已按扫描上限截断，仅覆盖部分文件</div>
          <div v-if="!replication.poolActive" class="stat-sub replica-warn">账号池未生效，副本统计已跳过</div>
        </div>
      </div>

      <div v-if="replication" class="replica-grid-split">
        <div class="stat-card">
          <h3>中继指标（近 {{ formatWindowText(relayMetricsView?.windowMs ?? 0) }}）</h3>
          <template v-if="relayMetricsView">
            <div class="metric-grid">
              <div class="metric-item">
                <span class="metric-label">中继尝试</span>
                <span class="metric-value">{{ relayMetricsView.attempts }}</span>
              </div>
              <div class="metric-item">
                <span class="metric-label">中继成功</span>
                <span class="metric-value">{{ relayMetricsView.relaySucceeded }}</span>
              </div>
              <div class="metric-item">
                <span class="metric-label">中继失败</span>
                <span class="metric-value">{{ relayMetricsView.relayFailed }}</span>
              </div>
              <div class="metric-item">
                <span class="metric-label">认领超时</span>
                <span class="metric-value">{{ relayMetricsView.claimTimeouts }}</span>
              </div>
            </div>

            <div class="stat-sub">
              成功率 {{ formatRate(relayMetricsView.relaySuccessRate, relayMetricsView.sampleSufficient) }}
              · 认领率 {{ formatRate(relayMetricsView.claimRate, relayMetricsView.sampleSufficient) }}
              · 达标 {{ relayMetricsView.succeeded }} · 部分成功 {{ relayMetricsView.partialSuccess }}
            </div>
            <div class="stat-sub">
              中继耗时 P50 {{ formatDuration(relayMetricsView.relayDurationP50Ms) }}
              · P95 {{ formatDuration(relayMetricsView.relayDurationP95Ms) }}
            </div>
            <div class="stat-sub">
              认领耗时 P50 {{ formatDuration(relayMetricsView.claimDurationP50Ms) }}
              · P95 {{ formatDuration(relayMetricsView.claimDurationP95Ms) }}
            </div>
            <div v-if="relayMetricsView.blocked > 0" class="stat-sub">
              配置/权限类阻塞 {{ relayMetricsView.blocked }} 次（未发生中继调用）
            </div>
            <div v-if="relayMetricsView.truncated" class="stat-sub replica-warn">
              统计按条数上限截断，仅覆盖最近部分轮次
            </div>

            <div v-if="relayMetricsView.failureReasons.length > 0" class="bar-list">
              <div v-for="item in relayMetricsView.failureReasons" :key="item.reason" class="bar-row">
                <span class="bar-label">{{ failureReasonText(item.reason) }}</span>
                <span class="bar-track">
                  <span class="bar-fill" :style="{ width: failureBarWidth(item.count) }" />
                </span>
                <span class="bar-count">{{ item.count }}</span>
              </div>
            </div>
            <div v-else class="stat-sub">窗口内没有中继失败记录</div>

            <p class="metric-contract">
              二次传输字节数恒为 0：扩散只做用户账号服务端中继，不发生文件字节下载/上传
              （策略 A 的「Bot 重新上传到备份群」路径已彻底移除）。
            </p>
          </template>
          <div v-else class="stat-sub">指标数据不可用（观测未装配）</div>
        </div>

        <div class="stat-card">
          <h3>大文件覆盖率（Bot 直链）</h3>
          <template v-if="largeFileCoverage?.primary">
            <div class="tier-block">
              <div class="tier-head">
                <span class="tier-label">{{ largeFileCoverage.primary.label }}</span>
                <span class="cell-strong">
                  {{ largeFileCoverage.primary.satisfied }} / {{ largeFileCoverage.primary.files }}
                </span>
              </div>
              <div class="stat-sub">未达标 {{ largeFileCoverage.primary.unsatisfied }} 个文件</div>
              <div class="stat-sub">
                ready 账号数分布：{{ readyDistributionText(largeFileCoverage.primary.readyAccountCounts) }}
              </div>
              <ul v-if="largeFileCoverage.primary.missingSamples.length > 0" class="tier-missing">
                <li v-for="item in largeFileCoverage.primary.missingSamples" :key="item.ownerId">
                  {{ item.ownerId }}：现有 {{ item.readyAccountCount }} 路，缺 {{ item.missing }} 路
                </li>
              </ul>
            </div>
          </template>
          <div v-else class="stat-sub">≥4GiB 分层暂无文件</div>

          <div v-if="largeFileCoverage?.secondary" class="tier-block tier-secondary">
            <div class="tier-head">
              <span class="tier-label">{{ largeFileCoverage.secondary.label }}</span>
              <span class="cell-strong">
                {{ largeFileCoverage.secondary.satisfied }} / {{ largeFileCoverage.secondary.files }}
              </span>
            </div>
            <div class="stat-sub">
              未达标 {{ largeFileCoverage.secondary.unsatisfied }} 个文件
              · ready 分布：{{ readyDistributionText(largeFileCoverage.secondary.readyAccountCounts) }}
            </div>
          </div>

          <div v-if="largeFileCoverage" class="stat-sub">
            副本已登记账号 {{ largeFileCoverage.readyAccounts }} 个
            · 当前可调度账号 {{ largeFileCoverage.schedulableAccounts }} 个
          </div>
          <div class="stat-sub">
            「已登记」是历史事实，「可调度」才是当前分流能力：账号冷却或未配置存储 Chat 时不参与分流。
          </div>
          <div v-if="largeFileCoverage?.truncated" class="stat-sub replica-warn">扫描已截断，仅覆盖部分文件</div>
        </div>
      </div>

      <p v-if="replication && !replication.poolActive" class="replica-warn">
        账号池当前未生效：以下账号资格与副本数据仅作诊断，不会触发任何扩散。
      </p>

      <div v-if="replication && replication.accounts.length > 0" class="table-scroll">
        <t-table
          :data="replication.accounts"
          :columns="replicaColumns"
          row-key="accountId"
          size="small"
          :loading="replicationLoading"
          table-layout="auto"
        >
          <template #enabled="{ row }">{{ row.enabled ? '已启用' : '已停用' }}</template>
          <template #storageConfigured="{ row }">{{ row.storageConfigured ? '已配置' : '未配置' }}</template>
          <template #health="{ row }">
            {{ row.consecutiveFailures > 0 ? `连续失败 ${row.consecutiveFailures} 次` : '正常' }}
          </template>
          <template #cooldown="{ row }">
            <span v-if="row.coolingDown" class="replica-warn">{{ formatCooldown(row.cooldownRemainingMs) }}</span>
            <span v-else class="cell-muted">—</span>
          </template>
          <template #inflight="{ row }">{{ row.inflight }} / {{ row.maxInflight }}</template>
          <template #eligible="{ row }">
            <t-tag :theme="row.eligible ? 'success' : 'warning'" variant="light" size="small">
              {{ row.eligible ? '可调度' : '不可调度' }}
            </t-tag>
          </template>
          <template #reasons="{ row }">
            <span :class="{ 'replica-warn': row.reasons.length > 0 }">
              {{ row.reasons.length > 0 ? row.reasons.join('；') : '—' }}
            </span>
          </template>
        </t-table>
      </div>

      <div v-if="coverage.missingSamples.length > 0" class="replica-missing">
        <h3>副本不足的文件（站内逻辑文件示例）</h3>
        <ul>
          <li v-for="item in coverage.missingSamples" :key="item.ownerId">
            {{ item.ownerId }}：现有 {{ item.readyAccountCount }} 路，缺 {{ item.missing }} 路
          </li>
        </ul>
      </div>

      <!-- 最近事件与处理动作：失败详情四段式 + 仅策略 B 手动重试 -->
      <div class="replica-attempts">
        <div class="attempts-head">
          <h3>最近事件与处理动作</h3>
          <span class="section-hint">
            只有「可重试失败」「认领超时」提供重试；重试只走用户账号中继，不提供策略选择。
          </span>
        </div>

        <!-- 重试结果：如实展示后端 requeued/created/ruleIds，0 重排明确写「无需重试」 -->
        <t-alert
          v-if="retryResult"
          :theme="retryResult.requeued + retryResult.created > 0 ? 'info' : 'warning'"
          :title="retryResult.requeued + retryResult.created > 0 ? '重试已受理' : '无需重试'"
          class="retry-result"
        >
          <p class="retry-result-message">{{ retryResult.message }}</p>
          <ul class="retry-result-metrics">
            <li>重排任务 {{ retryResult.requeued }} 条</li>
            <li>补建任务 {{ retryResult.created }} 条</li>
            <li>影响镜像规则 {{ retryResult.ruleIds.length }} 条</li>
          </ul>
          <p v-if="retryResult.requeued + retryResult.created === 0" class="retry-result-hint">
            该文件在当前镜像群上已有在途任务，本次未产生任何新的排队或补建：请直接观察下方任务状态，不要重复点击。
          </p>
          <p v-else-if="retryResult.ruleIds.length > 0" class="retry-result-hint">
            影响规则：{{ retryResult.ruleIds.join('、') }}
          </p>
          <t-button variant="text" size="small" @click="retryResult = null">关闭</t-button>
        </t-alert>

        <div v-if="recentAttempts.length === 0" class="empty-hint">窗口内没有扩散轮次记录</div>

        <ul v-else class="timeline">
          <li v-for="attempt in recentAttempts" :key="attempt.id" class="timeline-item">
            <span class="timeline-dot" :class="attemptDotClass(attempt.status)" />
            <div class="timeline-body">
              <div class="timeline-row">
                <span class="cell-mono">{{ attempt.ownerLabel }}</span>
                <t-tag :theme="attemptStatusTheme(attempt.status)" variant="light" size="small">
                  {{ attempt.statusLabel }}
                </t-tag>
                <span class="timeline-meta">{{ formatTime(attempt.createdAt) }}</span>
                <span class="timeline-meta">
                  中继 {{ formatDuration(attempt.relayDurationMs) }} · 认领 {{ formatDuration(attempt.claimDurationMs) }}
                </span>
                <span class="timeline-meta">认领账号 {{ attempt.claimedAccountIds.length }} 个</span>
                <span class="timeline-meta">缺口 {{ attempt.missingCount }} 路</span>
                <span v-if="attempt.retryCount > 0" class="timeline-meta">已重试 {{ attempt.retryCount }} 次</span>
                <span v-if="attempt.failureReasonLabel" class="cell-error">{{ attempt.failureReasonLabel }}</span>
                <span v-if="attempt.nextRetryAt" class="timeline-meta">下次重试 {{ formatTime(attempt.nextRetryAt) }}</span>
                <span class="timeline-actions">
                  <t-button variant="text" size="small" @click="toggleAttempt(attempt)">
                    {{ expandedAttemptId === attempt.id ? '收起详情' : '失败详情' }}
                  </t-button>
                  <t-button
                    v-if="attempt.retryable"
                    variant="text"
                    size="small"
                    :loading="retryingAttemptId === attempt.id"
                    @click="confirmRetryAttempt(attempt)"
                  >
                    重试
                  </t-button>
                </span>
              </div>

              <div v-if="expandedAttemptId === attempt.id" class="attempt-detail">
                <div v-if="attemptDetailLoading" class="cell-muted">详情加载中…</div>
                <template v-else-if="activeAttemptDetail">
                  <div class="detail-grid">
                    <div class="detail-item">
                      <span class="detail-label">为什么失败</span>
                      <p>{{ activeAttemptDetail.why }}</p>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">影响</span>
                      <p>{{ activeAttemptDetail.impact }}</p>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">建议操作</span>
                      <p>{{ activeAttemptDetail.advice }}</p>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">是否可重试</span>
                      <p>
                        {{ activeAttemptDetail.retryable
                          ? '可重试：点击「重试」重新执行一次用户账号中继（幂等，不产生重复群消息）。'
                          : '不可重试：请先按建议修正配置或权限，重试不会成功。' }}
                      </p>
                    </div>
                  </div>
                  <ul class="detail-timeline">
                    <li v-for="(step, index) in activeAttemptDetail.timeline" :key="`${step.at}-${index}`">
                      <span class="cell-mono">{{ formatTime(step.at) }}</span>
                      <span class="cell-strong">{{ step.label }}</span>
                      <span v-if="step.detail" class="kv-note">{{ step.detail }}</span>
                    </li>
                  </ul>
                </template>
                <div v-else class="cell-muted">详情不可用</div>
              </div>
            </div>
          </li>
        </ul>
      </div>

      <ul v-if="replication" class="replica-notes">
        <li v-for="note in replication.notes" :key="note">{{ note }}</li>
      </ul>
    </section>

    <!-- 账号区 -->
    <section class="card" aria-label="账号管理">
      <div class="section-header">
        <h3>账号</h3>
        <div class="section-actions">
          <t-button variant="outline" size="small" @click="openCreateBot">添加 Bot 账号</t-button>
          <t-button variant="outline" size="small" @click="openCreateUser">添加用户账号</t-button>
        </div>
      </div>

      <t-tabs v-model="accountTab" @change="onAccountTabChange">
        <t-tab-panel value="bot" label="Bot 账号" />
        <t-tab-panel value="user" label="用户账号" />
      </t-tabs>

      <!-- 环境变量账号只读区（独立于数据库账号列表，不参与分页/筛选） -->
      <div v-if="accountTab === 'bot'" class="env-accounts" aria-label="环境变量账号">
        <div class="env-accounts-head">
          <h4 class="env-accounts-title">环境变量账号</h4>
          <span class="section-hint">
            来自 .env（TELEGRAM_BOT_TOKEN / TELEGRAM_ACCOUNT_POOL），后台只读：密钥轮换请改 .env，不提供编辑/删除/轮换。
          </span>
        </div>

        <t-alert
          v-if="poolNotice"
          :theme="poolNotice.theme"
          :title="poolNotice.title"
          :message="poolNotice.message"
        />

        <div v-if="envAccounts.length === 0" class="empty-hint">未检测到环境变量账号</div>

        <ul v-else class="env-account-list">
          <li v-for="account in envAccounts" :key="account.id" class="env-account-row">
            <div class="env-account-main">
              <div class="env-account-head">
                <t-tag theme="primary" variant="light" size="small">环境变量</t-tag>
                <t-tag v-if="account.primary" theme="warning" variant="light" size="small">主 Bot</t-tag>
                <span class="cell-strong env-account-id">{{ account.id }}</span>
                <span class="cell-mono">{{ account.tokenPreview }}</span>
                <t-tag :theme="account.enabled ? 'success' : 'default'" variant="light" size="small">
                  {{ account.enabled ? '已启用' : '已停用' }}
                </t-tag>
              </div>

              <dl class="env-account-meta">
                <div class="env-meta-item">
                  <dt>存储 Chat</dt>
                  <dd>
                    <span v-if="account.chatId" class="cell-mono">{{ account.chatId }}</span>
                    <span v-else class="cell-muted">未配置存储 Chat</span>
                  </dd>
                </div>
                <div class="env-meta-item">
                  <dt>权重</dt>
                  <dd>{{ account.weight }}</dd>
                </div>
                <div class="env-meta-item">
                  <dt>在飞</dt>
                  <dd>{{ account.runtime.inflight }} / {{ account.runtime.maxInflight }}</dd>
                </div>
                <div class="env-meta-item">
                  <dt>带宽</dt>
                  <dd>{{ formatBandwidth(account.runtime.bandwidthMbps) }}</dd>
                </div>
                <div class="env-meta-item">
                  <dt>健康</dt>
                  <dd>
                    <t-tag :theme="envHealthTheme(account.runtime)" variant="light" size="small">
                      {{ envHealthText(account.runtime) }}
                    </t-tag>
                  </dd>
                </div>
                <div class="env-meta-item">
                  <dt>成功率</dt>
                  <dd>{{ formatSuccessRate(account.runtime.successRate) }}</dd>
                </div>
                <div class="env-meta-item">
                  <dt>冷却剩余</dt>
                  <dd>{{ formatCooldown(account.runtime.cooldownRemainingMs) }}</dd>
                </div>
                <div class="env-meta-item">
                  <dt>最近错误</dt>
                  <dd>{{ errorKindText(account.runtime.lastErrorKind) }}</dd>
                </div>
              </dl>

              <p v-if="!account.runtime.storageConfigured" class="env-account-warn">
                未配置存储 Chat：仅参与下载回源，不会被选为文件存储或镜像目标。
              </p>
            </div>

            <div class="env-account-actions">
              <t-button
                variant="outline"
                size="small"
                :loading="envProbingId === account.id"
                @click="runEnvProbe(account)"
              >
                重新探测
              </t-button>
            </div>
          </li>
        </ul>
      </div>

      <div class="table-filters">
        <t-select v-model="accountStatus" class="filter-select" placeholder="状态" @change="onAccountFilterChange">
          <t-option value="" label="全部（不含已撤销）" />
          <t-option value="active" :label="statusText('active')" />
          <t-option value="degraded" :label="statusText('degraded')" />
          <t-option value="disabled" :label="statusText('disabled')" />
          <t-option value="revoked" :label="statusText('revoked')" />
          <t-option value="pending_auth" :label="statusText('pending_auth')" />
        </t-select>
        <t-input
          v-model="accountKeyword"
          class="filter-input"
          placeholder="搜索名称或外部标识…"
          clearable
          autocomplete="off"
          name="telegram-account-keyword"
          @enter="onAccountFilterChange"
          @clear="onAccountFilterChange"
        />
        <t-button variant="outline" :loading="accountsLoading" @click="onAccountFilterChange">查询</t-button>
      </div>

      <div v-if="!isMobile" class="table-scroll">
        <t-table
          :data="accounts"
          :columns="accountColumns"
          :loading="accountsLoading"
          row-key="id"
          table-layout="fixed"
          :pagination="false"
          size="small"
        >
          <template #name="{ row }">
            <div class="cell-stack">
              <span class="cell-strong">{{ row.name }}</span>
              <span class="cell-mono">Token：{{ row.externalId || '—' }}</span>
              <t-tag v-if="row.source === 'both'" theme="primary" variant="light" size="small">
                双来源（环境变量优先）
              </t-tag>
              <span v-if="row.source === 'both'" class="cell-note">同一 Bot 已被环境变量注册，密钥以 .env 为准</span>
              <span v-if="row.runtime" class="cell-note">{{ runtimeSummary(row.runtime) }}</span>
            </div>
          </template>
          <template #status="{ row }">
            <t-tag :theme="statusTheme(row.status)" variant="light">{{ statusText(row.status) }}</t-tag>
          </template>
          <template #capabilities="{ row }">{{ capabilityText(row) }}</template>
          <template #enabled="{ row }">
            <t-switch
              :value="row.enabled"
              :disabled="row.status === 'revoked' || row.status === 'pending_auth'"
              @change="(v: boolean) => toggleAccountEnabled(row, Boolean(v))"
            />
          </template>
          <template #weight="{ row }">{{ row.weight }} / {{ row.maxInflight }}</template>
          <template #lastSuccessAt="{ row }">{{ formatTime(row.lastSuccessAt) }}</template>
          <template #lastError="{ row }">
            <span v-if="row.lastFailureSummary" class="cell-error">{{ row.lastFailureSummary }}</span>
            <span v-else class="cell-muted">—</span>
          </template>
          <template #operations="{ row }">
            <div class="row-actions">
              <t-button variant="text" size="small" @click="runAccountTest(row)">测试</t-button>
              <t-button
                v-if="row.type === 'user'"
                variant="text"
                size="small"
                @click="openAuthorize(row)"
              >
                授权
              </t-button>
              <t-button variant="text" size="small" @click="openEdit(row)">编辑</t-button>
              <t-button variant="text" size="small" @click="openRotate(row)">轮换</t-button>
              <t-button
                v-if="row.status !== 'revoked'"
                variant="text"
                theme="danger"
                size="small"
                @click="confirmDelete(row)"
              >
                删除
              </t-button>
            </div>
          </template>
        </t-table>
      </div>

      <div v-else class="mobile-card-list">
        <div v-for="row in accounts" :key="row.id" class="mobile-account-card">
          <div class="mobile-card-head">
            <span class="cell-strong">{{ row.name }}</span>
            <t-tag :theme="statusTheme(row.status)" variant="light">{{ statusText(row.status) }}</t-tag>
          </div>
          <div class="mobile-card-meta">Token：{{ row.externalId || '—' }}</div>
          <div v-if="row.source === 'both'" class="mobile-card-meta">
            双来源（环境变量优先）：密钥以 .env 为准
          </div>
          <div v-if="row.runtime" class="mobile-card-meta">运行态：{{ runtimeSummary(row.runtime) }}</div>
          <div class="mobile-card-meta">能力：{{ capabilityText(row) }}</div>
          <div class="mobile-card-meta">权重 / 并发：{{ row.weight }} / {{ row.maxInflight }}</div>
          <div class="mobile-card-meta">最近成功：{{ formatTime(row.lastSuccessAt) }}</div>
          <div v-if="row.lastFailureSummary" class="mobile-card-meta cell-error">最近错误：{{ row.lastFailureSummary }}</div>
          <div class="mobile-card-actions">
            <t-button variant="text" size="small" @click="runAccountTest(row)">测试</t-button>
            <t-button v-if="row.type === 'user'" variant="text" size="small" @click="openAuthorize(row)">授权</t-button>
            <t-button variant="text" size="small" @click="openEdit(row)">编辑</t-button>
            <t-button variant="text" size="small" @click="openRotate(row)">轮换</t-button>
            <t-button
              v-if="row.status !== 'revoked'"
              variant="text"
              theme="danger"
              size="small"
              @click="confirmDelete(row)"
            >
              删除
            </t-button>
          </div>
        </div>
        <div v-if="!accountsLoading && accounts.length === 0" class="empty-hint">暂无账号</div>
      </div>

      <div class="pagination-row">
        <t-pagination
          :current="accountPagination.current"
          :total="accountPagination.total"
          :page-size="accountPagination.pageSize"
          :page-size-options="[10, 20, 50]"
          size="small"
          @change="onAccountPageChange"
        />
      </div>
    </section>

    <!-- 镜像规则卡：多规则列表 + 新建/编辑 -->
    <section class="card" aria-label="镜像规则">
      <div class="section-header">
        <h3>镜像规则</h3>
        <div class="section-actions">
          <span class="section-hint-inline">
            当前主群：{{ mirror?.mainChatId || '未配置' }}
          </span>
          <t-button theme="primary" size="small" @click="openCreateRule">新建规则</t-button>
        </div>
      </div>

      <p class="section-hint">
        扩散链路：持有源消息的 Bot 先转发到「主群」，再由用户账号从主群服务端转发到各「镜像群」，
        最后由镜像群内的各存储 Bot 认领自己的副本。所有**启用中**的规则必须共用同一个主群；
        每条启用规则对应一个独立的镜像群，各自独立任务、重试与状态。全程零字节重传，不存在 Bot 重新上传。
      </p>

      <t-alert
        v-if="mirror && mirror.rules.length > 1 && !mirror.mainChatId"
        theme="warning"
        message="启用中的多条规则主群不一致：所有启用规则必须共用同一个主群（源群），否则同一文件会被搬运多次。"
      />

      <div v-if="mirror && mirror.rules.length > 0" class="mirror-rule-list">
        <div v-for="rule in mirror.rules" :key="rule.id" class="mirror-rule-row">
          <div class="mirror-rule-head">
            <span class="cell-strong">{{ rule.name || '未命名规则' }}</span>
            <t-tag :theme="rule.enabled ? 'success' : 'default'" variant="light">
              {{ rule.enabled ? '已启用' : '未启用' }}
            </t-tag>
            <t-tag :theme="ruleTestTheme(rule.lastTestStatus)" variant="light">
              权限测试：{{ testStatusText(rule.lastTestStatus) }}
            </t-tag>
          </div>
          <div class="mirror-rule-meta">
            主群（源群，副本扩散中转落点）：<span class="cell-mono">{{ rule.sourceChatId || '—' }}</span>
          </div>
          <div class="mirror-rule-meta">
            镜像群（备份群）：<span class="cell-mono">{{ rule.targetChatId || '—' }}</span>
          </div>
          <div class="mirror-rule-meta">
            优先账号：{{ rule.preferredAccountId || '自动选择' }} · 事件范围：{{ ruleEventScopeText(rule) }}
          </div>
          <div v-if="rule.lastTestSummary" class="mirror-rule-meta cell-muted">
            测试摘要：{{ rule.lastTestSummary }}
          </div>
          <div class="mirror-rule-actions">
            <div class="mirror-rule-switch">
              <span class="field-label">启用该镜像群</span>
              <t-switch
                :value="rule.enabled"
                :loading="togglingRuleId === rule.id"
                :aria-label="`启用镜像规则 ${rule.name || rule.targetChatId}`"
                @change="(v: boolean) => toggleRuleEnabled(rule, Boolean(v))"
              />
            </div>
            <div class="mobile-card-actions">
              <t-button variant="text" size="small" :loading="testingRuleId === rule.id" @click="runMirrorTest(rule)">
                测试权限
              </t-button>
              <t-button variant="text" size="small" @click="openEditRule(rule)">编辑</t-button>
              <t-button variant="text" size="small" theme="danger" @click="confirmDeleteRule(rule)">删除</t-button>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty-hint">尚未配置镜像规则</div>

      <div class="mirror-form">
        <div class="mirror-form-head">
          <span class="field-label">{{ mirrorForm.id ? '编辑规则' : '新建规则' }}</span>
          <span class="section-hint-inline">主群/镜像群变更后需重新执行权限测试才能启用</span>
        </div>
        <label class="field">
          <span class="field-label">规则名称</span>
          <t-input v-model="mirrorForm.name" placeholder="便于识别的名称" autocomplete="off" name="mirror-name" />
        </label>
        <label class="field">
          <span class="field-label">主群（源群，副本扩散中转落点）</span>
          <t-input v-model="mirrorForm.sourceChatId" placeholder="例如 -1001234567890" autocomplete="off" name="mirror-source" />
        </label>
        <label class="field">
          <span class="field-label">镜像群（备份群）</span>
          <t-input v-model="mirrorForm.targetChatId" placeholder="例如 -1000987654321" autocomplete="off" name="mirror-target" />
        </label>
        <label class="field">
          <span class="field-label">优先账号（可空，留空自动选号）</span>
          <t-input v-model="mirrorForm.preferredAccountId" placeholder="留空自动选择" autocomplete="off" name="mirror-preferred-account" />
        </label>

        <div class="mirror-events">
          <span class="field-label">事件范围</span>
          <t-checkbox v-model="mirrorForm.includeWebUploads">Web 上传</t-checkbox>
          <t-checkbox v-model="mirrorForm.includeBotInboundFiles">Bot 入站</t-checkbox>
        </div>

        <div class="field field-actions">
          <t-button theme="primary" :loading="savingMirror" @click="saveMirrorRule">保存规则</t-button>
          <t-button v-if="mirrorForm.id" variant="outline" @click="resetMirrorForm">取消编辑</t-button>
        </div>
      </div>

      <t-alert theme="info" :message="mirrorModeHint" />

      <div v-if="mirrorTestResult" class="test-result">
        <div class="test-result-head">
          <t-tag :theme="mirrorTestResult.status === 'ok' ? 'success' : 'danger'" variant="light">
            {{ mirrorTestResult.status === 'ok' ? '测试通过' : '测试失败' }}
          </t-tag>
          <span class="test-result-summary">
            {{ mirrorTestResult.ruleName ? `「${mirrorTestResult.ruleName}」` : '' }}{{ mirrorTestResult.summary }}
          </span>
        </div>
        <ul class="test-details">
          <li v-for="(detail, index) in mirrorTestResult.details" :key="index" class="test-detail">
            <span class="test-detail-role">{{ detail.chat === 'source' ? '主群' : '镜像群' }}</span>
            <t-tag :theme="detail.ok ? 'success' : 'danger'" variant="light">{{ detail.ok ? '可用' : '不可用' }}</t-tag>
            <span class="test-detail-text">{{ detail.title || '—' }}{{ detail.type ? `（${detail.type}）` : '' }}</span>
            <span v-if="!detail.ok && detail.error" class="cell-error">{{ detail.error }}</span>
          </li>
        </ul>
      </div>
    </section>

    <!-- 历史补偿：把历史文件按批限速补做镜像备份 -->
    <section class="card" aria-label="历史补偿">
      <div class="section-header">
        <h3>历史补偿</h3>
        <div class="section-actions">
          <t-button
            v-if="backfillIdle"
            theme="default"
            variant="outline"
            :loading="backfillSaving"
            @click="runBackfill('dry-run')"
          >
            评估影响面
          </t-button>
          <t-button v-if="backfillIdle" theme="primary" :loading="backfillSaving" @click="runBackfill('apply')">
            开始补偿
          </t-button>
          <t-button
            v-if="backfill.status === 'running'"
            :loading="backfillSaving"
            @click="controlBackfill('pause')"
          >
            暂停
          </t-button>
          <t-button
            v-if="backfill.status === 'paused'"
            :loading="backfillSaving"
            @click="controlBackfill('resume')"
          >
            恢复
          </t-button>
          <t-button
            v-if="backfill.status === 'running' || backfill.status === 'paused'"
            theme="danger"
            variant="outline"
            :loading="backfillSaving"
            @click="controlBackfill('cancel')"
          >
            取消
          </t-button>
        </div>
      </div>

      <div class="field-row">
        <span class="field-label">状态</span>
        <t-tag :theme="backfillStatusTheme" variant="light">{{ backfillStatusText }}</t-tag>
        <span class="field-label">模式</span>
        <span>{{ backfill.mode === 'apply' ? '实际入队' : '仅评估' }}</span>
        <span class="field-label">已扫描</span>
        <span>{{ backfill.scanned }}</span>
        <span class="field-label">已入队</span>
        <span>{{ backfill.queued }}</span>
        <span class="field-label">已跳过</span>
        <span>{{ backfill.skipped }}</span>
      </div>

      <p class="section-hint">
        补偿会为历史文件补齐「主群搬运 + 用户账号中继到各镜像群」的任务（全程服务端转发，不产生文件字节流量）：
        按批扫描（每批 20 个、间隔 1 秒），可随时暂停或取消；
        重复运行不会产生重复备份（任务幂等键保证），也不会改变现有下载链接。
      </p>

      <t-alert v-if="backfill.lastError" theme="warning" :message="backfill.lastError" />
      <div v-if="backfill.sample.length > 0" class="field-row">
        <span class="section-hint">样本文件 ID（最多 20 个）：</span>
        <code v-for="sampleId in backfill.sample" :key="sampleId" class="cell-mono">{{ sampleId }}</code>
      </div>
    </section>

    <!-- 任务列表区：按镜像群（targetChatId）分组，避免多群失败混成一锅 -->
    <section class="card" aria-label="镜像任务">
      <div class="section-header">
        <h3>镜像任务</h3>
        <div class="section-actions">
          <span class="section-hint-inline">
            按镜像群分组：每条启用规则对应一个镜像群，各自独立任务/重试/状态
          </span>
        </div>
      </div>

      <div class="table-filters">
        <t-select v-model="taskFilters.status" class="filter-select" placeholder="状态">
          <t-option value="" label="全部状态" />
          <t-option value="queued" label="排队中" />
          <t-option value="running" label="执行中" />
          <t-option value="retrying" label="重试中" />
          <t-option value="succeeded" label="成功" />
          <t-option value="failed" label="失败" />
          <t-option value="blocked" label="阻塞" />
          <t-option value="cancelled" label="已取消" />
        </t-select>
        <t-input
          v-model="taskFilters.ownerId"
          class="filter-input"
          placeholder="主文件 ID"
          clearable
          autocomplete="off"
          name="mirror-owner-id"
          @enter="onTaskFilterChange"
          @clear="onTaskFilterChange"
        />
        <t-input
          v-model="taskFilters.accountId"
          class="filter-input"
          placeholder="账号 ID"
          clearable
          autocomplete="off"
          name="mirror-account-id"
          @enter="onTaskFilterChange"
          @clear="onTaskFilterChange"
        />
        <t-button variant="outline" :loading="tasksLoading" @click="onTaskFilterChange">查询</t-button>
      </div>

      <div v-if="!tasksLoading && taskRows.length === 0" class="empty-hint">暂无镜像任务</div>

      <div v-else class="task-groups">
        <div v-for="group in taskGroups" :key="group.key" class="task-group">
          <div class="task-group-head">
            <span class="cell-strong task-group-chat">
              镜像群：<span class="cell-mono">{{ group.chatId || '未归属（历史任务）' }}</span>
            </span>
            <span class="kv-note">{{ group.ruleLabel }}</span>
            <t-tag :theme="taskGroupTheme(group)" variant="light" size="small">
              失败 {{ group.failedCount }} · 阻塞 {{ group.blockedCount }} · 进行中 {{ group.pendingCount }}
            </t-tag>
          </div>

          <p v-if="group.lastErrorSummary" class="task-group-error">
            最近失败原因：{{ group.lastErrorSummary }}
            <span v-if="group.lastErrorCode" class="cell-mono">（{{ group.lastErrorCode }}）</span>
            <span v-if="group.lastErrorAt" class="cell-muted"> · {{ formatTime(group.lastErrorAt) }}</span>
          </p>
          <p v-else class="kv-note">该镜像群暂无失败记录</p>

          <div v-if="!isMobile" class="table-scroll">
            <t-table
              :data="group.items"
              :columns="taskColumns"
              :loading="tasksLoading"
              row-key="id"
              table-layout="fixed"
              :pagination="false"
              size="small"
            >
              <template #ownerId="{ row }">
                <span class="cell-mono">{{ row.ownerId }}</span>
              </template>
              <template #targetAccountId="{ row }">
                <span class="cell-mono">{{ row.targetAccountId || '—' }}</span>
              </template>
              <template #targetMessageId="{ row }">{{ row.targetMessageId || '—' }}</template>
              <template #attempts="{ row }">{{ row.attempts }}</template>
              <template #lastError="{ row }">
                <span v-if="row.lastErrorSummary" class="cell-error">{{ row.lastErrorSummary }}</span>
                <span v-else class="cell-muted">—</span>
              </template>
              <template #time="{ row }">{{ formatTime(row.updatedAt || row.createdAt) }}</template>
              <template #operations="{ row }">
                <div class="row-actions">
                  <t-button
                    v-if="canRetry(row)"
                    variant="text"
                    size="small"
                    @click="doRetryTask(row)"
                  >
                    重试
                  </t-button>
                  <t-button
                    v-if="canCancel(row)"
                    variant="text"
                    theme="danger"
                    size="small"
                    @click="doCancelTask(row)"
                  >
                    取消
                  </t-button>
                  <t-tooltip v-if="isRunning(row)" content="执行中不可取消">
                    <span class="disabled-action">取消</span>
                  </t-tooltip>
                </div>
              </template>
            </t-table>
          </div>

          <div v-else class="mobile-card-list">
            <div v-for="row in group.items" :key="row.id" class="mobile-task-card">
              <div class="mobile-card-head">
                <span class="cell-mono">{{ row.ownerId }}</span>
                <t-tag :theme="taskStatusTheme(row.status)" variant="light">{{ taskStatusText(row.status) }}</t-tag>
              </div>
              <div class="mobile-card-meta">执行账号：{{ row.targetAccountId || '—' }}</div>
              <div class="mobile-card-meta">目标消息：{{ row.targetMessageId || '—' }} · 重试 {{ row.attempts }}</div>
              <div v-if="row.lastErrorSummary" class="mobile-card-meta cell-error">错误：{{ row.lastErrorSummary }}</div>
              <div class="mobile-card-meta">{{ formatTime(row.updatedAt || row.createdAt) }}</div>
              <div class="mobile-card-actions">
                <t-button v-if="canRetry(row)" variant="text" size="small" @click="doRetryTask(row)">重试</t-button>
                <t-button v-if="canCancel(row)" variant="text" theme="danger" size="small" @click="doCancelTask(row)">取消</t-button>
                <span v-if="isRunning(row)" class="disabled-action">执行中不可取消</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="pagination-row">
        <t-pagination
          :current="taskPagination.current"
          :total="taskPagination.total"
          :page-size="taskPagination.pageSize"
          :page-size-options="[10, 20, 50]"
          size="small"
          @change="onTaskPageChange"
        />
      </div>
    </section>

    <div class="audit-entry">
      <router-link to="/admin/audit-logs">前往操作审计查看相关记录</router-link>
    </div>

    <!-- 新增 / 编辑账号弹窗 -->
    <t-dialog
      v-model:visible="accountDialogVisible"
      :header="accountDialogHeader"
      :footer="false"
    >
      <div class="dialog-form">
        <label class="field">
          <span class="field-label">名称</span>
          <t-input v-model="accountForm.name" placeholder="便于识别的名称" autocomplete="off" name="account-name" />
        </label>

        <template v-if="accountFormMode === 'create-bot'">
          <label class="field">
            <span class="field-label">Bot Token</span>
            <t-input v-model="accountForm.token" type="password" placeholder="<botId>:<secret>" autocomplete="off" name="account-token" />
          </label>
          <label class="field">
            <span class="field-label">主存储 Chat ID</span>
            <t-input v-model="accountForm.primaryChatId" placeholder="可空" autocomplete="off" name="account-primary-chat" />
          </label>
          <div class="field-row">
            <label class="field">
              <span class="field-label">权重</span>
              <t-input-number v-model="accountForm.weight" :min="1" :max="100" />
            </label>
            <label class="field">
              <span class="field-label">并发上限</span>
              <t-input-number v-model="accountForm.maxInflight" :min="1" :max="64" />
            </label>
          </div>
        </template>

        <template v-else-if="accountFormMode === 'create-user'">
          <label class="field">
            <span class="field-label">API ID</span>
            <t-input-number v-model="accountForm.apiId" :min="1" />
          </label>
          <label class="field">
            <span class="field-label">API Hash</span>
            <t-input v-model="accountForm.apiHash" type="password" autocomplete="off" name="account-api-hash" />
          </label>
          <label class="field">
            <span class="field-label">手机号</span>
            <t-input v-model="accountForm.phoneNumber" placeholder="+8613800000000" autocomplete="off" name="account-phone" />
          </label>
        </template>

        <template v-else>
          <div class="field-row">
            <label class="field">
              <span class="field-label">权重</span>
              <t-input-number v-model="accountForm.weight" :min="1" :max="100" />
            </label>
            <label class="field">
              <span class="field-label">并发上限</span>
              <t-input-number v-model="accountForm.maxInflight" :min="1" :max="64" />
            </label>
          </div>
          <label class="field">
            <span class="field-label">主存储 Chat ID</span>
            <t-input v-model="accountForm.primaryChatId" placeholder="可空" autocomplete="off" name="account-primary-chat" />
          </label>
        </template>

        <label class="field">
          <span class="field-label">备注</span>
          <t-textarea v-model="accountForm.note" :maxlength="255" placeholder="可空" />
        </label>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="closeAccountDialog">取消</t-button>
        <t-button theme="primary" :loading="accountDialogSubmitting" @click="submitAccountForm">
          {{ accountDialogSubmitting ? '提交中…' : '提交' }}
        </t-button>
      </div>
    </t-dialog>

    <!-- 用户账号授权弹窗（发送验证码 → 提交验证码） -->
    <t-dialog
      v-model:visible="authDialogVisible"
      header="用户账号授权"
      :footer="false"
    >
      <div class="dialog-form">
        <template v-if="authStep === 'code'">
          <p class="dialog-hint">验证码将发送到该账号的 Telegram 客户端，请确保手机号带国家码。</p>
          <label class="field">
            <span class="field-label">手机号</span>
            <t-input v-model="authPhoneNumber" placeholder="+8613800000000" autocomplete="off" name="auth-phone" />
          </label>
        </template>
        <template v-else>
          <p class="dialog-hint">
            验证码已发送<template v-if="authPhoneMasked">（{{ authPhoneMasked }}）</template>，请在 10 分钟内提交。
          </p>
          <label class="field">
            <span class="field-label">验证码</span>
            <t-input v-model="authCode" placeholder="Telegram 收到的验证码" autocomplete="off" name="auth-code" />
          </label>
          <label class="field">
            <span class="field-label">2FA 密码（可选）</span>
            <t-input v-model="authPassword" type="password" placeholder="如账号开启了两步验证" autocomplete="off" name="auth-password" />
          </label>
        </template>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="closeAuthDialog">取消</t-button>
        <t-button theme="primary" :loading="authSending || authVerifying" @click="advanceAuth">
          {{ authStep === 'code' ? (authSending ? '发送中…' : '发送验证码') : (authVerifying ? '提交中…' : '提交授权') }}
        </t-button>
      </div>
    </t-dialog>

    <!-- 轮换凭据弹窗 -->
    <t-dialog
      v-model:visible="rotateDialogVisible"
      :header="rotateDialogHeader"
      :confirm-btn="{ content: rotateSubmitting ? '提交中…' : '提交', loading: rotateSubmitting }"
      @confirm="submitRotate"
    >
      <div class="dialog-form">
        <template v-if="rotateType === 'bot'">
          <label class="field">
            <span class="field-label">新 Bot Token</span>
            <t-input v-model="rotateForm.token" type="password" placeholder="<botId>:<secret>" autocomplete="off" name="rotate-token" />
          </label>
          <label class="field">
            <span class="field-label">主存储 Chat ID</span>
            <t-input v-model="rotateForm.primaryChatId" placeholder="留空则保持原值" autocomplete="off" name="rotate-primary-chat" />
          </label>
        </template>
        <template v-else>
          <p class="dialog-hint">更新凭据后需要重新完成交互式授权。</p>
          <label class="field">
            <span class="field-label">API ID</span>
            <t-input-number v-model="rotateForm.apiId" :min="1" />
          </label>
          <label class="field">
            <span class="field-label">API Hash</span>
            <t-input v-model="rotateForm.apiHash" type="password" autocomplete="off" name="rotate-api-hash" />
          </label>
          <label class="field">
            <span class="field-label">手机号</span>
            <t-input v-model="rotateForm.phoneNumber" autocomplete="off" name="rotate-phone" />
          </label>
        </template>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="rotateDialogVisible = false">取消</t-button>
        <t-button theme="primary" :loading="rotateSubmitting" @click="submitRotate">
          {{ rotateSubmitting ? '提交中…' : '提交' }}
        </t-button>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { DialogPlugin } from 'tdesign-vue-next';
import MessagePlugin from '@/utils/message';
import { getErrorMessage } from '@/utils/error';
import { useMobile } from '@/composables/useMobile';
import {
  RELAY_FAILURE_REASON_LABELS,
  cancelMirrorBackfill,
  cancelMirrorTask,
  createBotAccount,
  createMirrorRule,
  createUserAccount,
  deleteAccount,
  deleteMirrorRule,
  fetchAccountOverview,
  fetchMirrorBackfill,
  fetchAccounts,
  fetchMirrorOverview,
  fetchMirrorTasks,
  fetchReplicationAttemptDetail,
  fetchReplicationAudit,
  pauseMirrorBackfill,
  probeEnvAccount,
  resumeMirrorBackfill,
  retryMirrorTask,
  retryReplicationAttempt,
  runRelayPreflight,
  rotateAccount,
  setAccountPoolEnabled,
  startMirrorBackfill,
  setMirrorEnabled,
  setMirrorRuleEnabled,
  startUserAuth,
  testAccount,
  testMirrorRule,
  updateAccount,
  updateMirrorRule,
  updateReplicationTarget,
  verifyUserAuth,
  type AccountPoolOverview,
  type MirrorBackfillJob,
  type MirrorBackfillStatus,
  type MirrorOverview,
  type MirrorRule,
  type MirrorRuleTestResult,
  type MirrorTaskListItem,
  type MirrorTaskSummary,
  type RelayCapabilitySnapshot,
  type RelayCheckStatus,
  type RelayPreflightReport,
  type ReplicationAttemptDetailView,
  type ReplicationAttemptStatus,
  type ReplicationAttemptView,
  type ReplicationAuditReport,
  type ReplicationRetryResult,
  type UserRelayFailureReason,
  type TelegramAccountRuntimeView,
  type TelegramAccountStatus,
  type TelegramAccountType,
  type TelegramAccountView,
  type TelegramEnvAccountView,
  type TelegramMirrorTaskStatus,
  type UpdateTelegramAccountInput,
  type UpdateMirrorRuleInput,
} from '@/api/telegram-accounts';

const isMobile = useMobile();

// ---------------- 总览 ----------------

const overview = ref<AccountPoolOverview | null>(null);
const mirror = ref<MirrorOverview | null>(null);
const featureSaving = ref(false);

const counts = computed(() => overview.value?.counts ?? {
  total: 0,
  bot: 0,
  user: 0,
  enabled: 0,
  active: 0,
  degraded: 0,
  disabled: 0,
  revoked: 0,
  pendingAuth: 0,
});

const emptyTaskSummary: MirrorTaskSummary = {
  queued: 0,
  running: 0,
  succeeded: 0,
  retrying: 0,
  failed: 0,
  blocked: 0,
  cancelled: 0,
  todaySucceeded: 0,
  todayFailed: 0,
  todayBlocked: 0,
  lastError: null,
};
const tasks = computed<MirrorTaskSummary>(() => mirror.value?.tasks ?? emptyTaskSummary);

/** 账号池与镜像两处 precheck 的未通过项（去重后合并展示） */
const precheckFailures = computed(() => {
  const items = [
    ...(overview.value?.precheck ?? []),
    ...(mirror.value?.precheck ?? []),
  ];
  const seen = new Set<string>();
  return items.filter((item) => {
    if (item.ok || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
});

/** 全部规则数（每条规则对应一个镜像群） */
const mirrorRuleCount = computed(() => mirror.value?.rules.length ?? 0);

/** 启用中的规则数（= 当前扩散目标数；由后端统计） */
const enabledRuleCount = computed(() => mirror.value?.enabledRuleCount ?? 0);

// ---------------- 账号列表 ----------------

const accountTab = ref<TelegramAccountType>('bot');
const accounts = ref<TelegramAccountView[]>([]);
const accountsLoading = ref(false);
const accountKeyword = ref('');
/** 账号状态筛选：默认空字符串 = 「全部（不含已撤销）」（后端默认即排除 revoked） */
const accountStatus = ref<TelegramAccountStatus | ''>('');
const accountPagination = reactive({ current: 1, pageSize: 20, total: 0 });

const accountColumns = [
  { colKey: 'name', title: '名称', width: 200 },
  { colKey: 'status', title: '状态', width: 100 },
  { colKey: 'capabilities', title: '能力', width: 180 },
  { colKey: 'enabled', title: '启用', width: 80 },
  { colKey: 'weight', title: '权重 / 并发', width: 110 },
  { colKey: 'lastSuccessAt', title: '最近成功', width: 160 },
  { colKey: 'lastError', title: '最近错误', width: 220 },
  { colKey: 'operations', title: '操作', width: 240 },
];

const STATUS_TEXT: Record<TelegramAccountStatus, string> = {
  active: '正常',
  degraded: '降级',
  disabled: '已停用',
  revoked: '已撤销',
  pending_auth: '待授权',
  draining: '排空中',
};

const STATUS_THEME: Record<TelegramAccountStatus, 'default' | 'success' | 'warning' | 'danger'> = {
  active: 'success',
  degraded: 'warning',
  disabled: 'default',
  revoked: 'danger',
  pending_auth: 'warning',
  draining: 'default',
};

function statusText(status: TelegramAccountStatus): string {
  return STATUS_TEXT[status] ?? status;
}

function statusTheme(status: TelegramAccountStatus): 'default' | 'success' | 'warning' | 'danger' {
  return STATUS_THEME[status] ?? 'default';
}

function capabilityText(account: TelegramAccountView): string {
  const caps = account.capabilities;
  if (!caps) return '未测试';
  const parts: string[] = [];
  if (caps.canUpload) parts.push('可上传');
  if (caps.canReadSource) parts.push('可读源');
  if (caps.canWriteMirror) parts.push('可写备份');
  if (caps.supportsPolling) parts.push('可轮询');
  return parts.length > 0 ? parts.join(' / ') : '无可用能力';
}

function featureSourceText(source: string | undefined): string {
  switch (source) {
    case 'runtime':
      return '来源：运行时配置';
    case 'env':
      return '来源：环境变量';
    case 'forced_disabled':
      return '来源：强制关闭';
    default:
      return '来源：默认值';
  }
}

function testStatusText(status: 'untested' | 'ok' | 'failed' | undefined): string {
  if (status === 'ok') return '通过';
  if (status === 'failed') return '失败';
  return '未测试';
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function loadAccounts() {
  accountsLoading.value = true;
  try {
    const { items, total } = await fetchAccounts({
      type: accountTab.value,
      // 仅在选择具体状态时传 status；默认空字符串不传，等价于「全部（不含已撤销）」
      status: accountStatus.value || undefined,
      keyword: accountKeyword.value.trim() || undefined,
      page: accountPagination.current,
      pageSize: accountPagination.pageSize,
    });
    accounts.value = items;
    accountPagination.total = total;
  } catch {
    // 加载失败不得用空值覆盖既有数据，只提示错误
    MessagePlugin.error('账号列表加载失败，已保留上次数据');
  } finally {
    accountsLoading.value = false;
  }
}

function onAccountTabChange() {
  accountPagination.current = 1;
  loadAccounts();
}

function onAccountFilterChange() {
  accountPagination.current = 1;
  loadAccounts();
}

function onAccountPageChange(pageInfo: { current: number; pageSize: number }) {
  accountPagination.current = pageInfo.current;
  accountPagination.pageSize = pageInfo.pageSize;
  loadAccounts();
}

// ---------------- 账号弹窗 ----------------

type AccountFormMode = 'create-bot' | 'create-user' | 'edit';

const accountDialogVisible = ref(false);
const accountDialogSubmitting = ref(false);
const accountFormMode = ref<AccountFormMode>('create-bot');
const editingAccountId = ref<string | null>(null);
const accountForm = reactive({
  name: '',
  token: '',
  primaryChatId: '',
  weight: 1,
  maxInflight: 8,
  apiId: 1,
  apiHash: '',
  phoneNumber: '',
  note: '',
});

const accountDialogHeader = computed(() => {
  if (accountFormMode.value === 'create-bot') return '添加 Bot 账号';
  if (accountFormMode.value === 'create-user') return '添加用户账号';
  return '编辑账号';
});

function resetAccountForm() {
  accountForm.name = '';
  accountForm.token = '';
  accountForm.primaryChatId = '';
  accountForm.weight = 1;
  accountForm.maxInflight = 8;
  accountForm.apiId = 1;
  accountForm.apiHash = '';
  accountForm.phoneNumber = '';
  accountForm.note = '';
}

function openCreateBot() {
  resetAccountForm();
  accountFormMode.value = 'create-bot';
  editingAccountId.value = null;
  accountDialogVisible.value = true;
}

function openCreateUser() {
  resetAccountForm();
  accountFormMode.value = 'create-user';
  editingAccountId.value = null;
  accountDialogVisible.value = true;
}

function openEdit(account: TelegramAccountView) {
  resetAccountForm();
  accountFormMode.value = 'edit';
  editingAccountId.value = account.id;
  accountForm.name = account.name;
  accountForm.weight = account.weight;
  accountForm.maxInflight = account.maxInflight;
  accountForm.primaryChatId = account.primaryChatId ?? '';
  accountForm.note = account.note ?? '';
  accountDialogVisible.value = true;
}

function closeAccountDialog() {
  accountDialogVisible.value = false;
  // 立即清空敏感字段（Token / API Hash 不留在组件状态里）
  accountForm.token = '';
  accountForm.apiHash = '';
}

async function submitAccountForm() {
  if (accountDialogSubmitting.value) return;
  accountDialogSubmitting.value = true;
  try {
    let postCreateAuthAccount: TelegramAccountView | null = null;
    if (accountFormMode.value === 'create-bot') {
      if (!accountForm.name.trim() || !accountForm.token.trim()) {
        MessagePlugin.warning('请填写名称与 Bot Token');
        return;
      }
      await createBotAccount({
        name: accountForm.name.trim(),
        token: accountForm.token.trim(),
        primaryChatId: accountForm.primaryChatId.trim() || undefined,
        weight: accountForm.weight,
        maxInflight: accountForm.maxInflight,
        note: accountForm.note.trim() || undefined,
      });
      MessagePlugin.success('Bot 账号已添加');
    } else if (accountFormMode.value === 'create-user') {
      if (!accountForm.name.trim() || !accountForm.apiHash.trim()) {
        MessagePlugin.warning('请填写名称与 API 凭据');
        return;
      }
      const created = await createUserAccount({
        name: accountForm.name.trim(),
        apiId: accountForm.apiId,
        apiHash: accountForm.apiHash.trim(),
        phoneNumber: accountForm.phoneNumber.trim() || undefined,
        note: accountForm.note.trim() || undefined,
      });
      MessagePlugin.success('用户账号已创建，请完成交互式授权');
      postCreateAuthAccount = created.account;
    } else if (editingAccountId.value) {
      const payload: UpdateTelegramAccountInput = {
        name: accountForm.name.trim() || undefined,
        weight: accountForm.weight,
        maxInflight: accountForm.maxInflight,
        primaryChatId: accountForm.primaryChatId.trim(),
        note: accountForm.note.trim(),
      };
      await updateAccount(editingAccountId.value, payload);
      MessagePlugin.success('账号已更新');
    }
    const prefillPhone = accountForm.phoneNumber.trim();
    closeAccountDialog();
    await Promise.all([loadAccounts(), loadOverview()]);
    // 用户账号创建后处于待授权状态：直接进入「发送验证码」步骤
    if (postCreateAuthAccount) {
      openAuthorize(postCreateAuthAccount);
      if (prefillPhone) authPhoneNumber.value = prefillPhone;
    }
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    accountDialogSubmitting.value = false;
  }
}

// ---------------- 账号行操作 ----------------

async function toggleAccountEnabled(account: TelegramAccountView, enabled: boolean) {
  try {
    await updateAccount(account.id, { enabled });
    MessagePlugin.success(enabled ? '账号已启用' : '账号已停用');
    await Promise.all([loadAccounts(), loadOverview()]);
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function runAccountTest(account: TelegramAccountView) {
  try {
    await testAccount(account.id);
    MessagePlugin.success('测试完成');
    await Promise.all([loadAccounts(), loadOverview()]);
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
    await loadAccounts();
  }
}

function confirmDelete(account: TelegramAccountView) {
  const dialog = DialogPlugin.confirm({
    header: '删除账号',
    body: `确定删除账号「${account.name}」吗？删除后立即停止参与新任务并清空凭据，Telegram 远端备份不会被删除。`,
    theme: 'danger',
    onConfirm: async () => {
      dialog.destroy();
      try {
        await deleteAccount(account.id);
        MessagePlugin.success('账号已撤销');
        // 撤销后该行默认不再出现在列表：若本页仅剩这一条，回退一页避免停留在空页
        if (accounts.value.length === 1 && accountPagination.current > 1) {
          accountPagination.current -= 1;
        }
        await Promise.all([loadAccounts(), loadOverview()]);
      } catch (error) {
        MessagePlugin.error(getErrorMessage(error));
      }
    },
    onClose: () => dialog.destroy(),
  });
}

// ---------------- 环境变量账号（只读） ----------------

/** 环境变量账号只读视图（来自总览；独立于数据库账号列表，不参与分页/筛选） */
const envAccounts = computed<TelegramEnvAccountView[]>(() => overview.value?.envAccounts ?? []);

const envProbingId = ref<string | null>(null);

const ERROR_KIND_TEXT: Record<string, string> = {
  flood: '限流',
  unavailable: '不可用',
  timeout: '超时',
  network: '网络',
  other: '其它',
};

function errorKindText(kind: string | null): string {
  if (!kind) return '无';
  return ERROR_KIND_TEXT[kind] ?? kind;
}

function formatBandwidth(mbps: number): string {
  if (!Number.isFinite(mbps) || mbps <= 0) return '—';
  return `${mbps.toFixed(1)} Mbps`;
}

function formatSuccessRate(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

function formatCooldown(ms: number): string {
  if (!ms || ms <= 0) return '—';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.ceil(seconds / 60)} 分钟`;
}

function envHealthTheme(runtime: TelegramAccountRuntimeView): 'success' | 'warning' | 'danger' {
  if (runtime.coolingDown) return 'danger';
  if (runtime.consecutiveFailures > 0) return 'warning';
  return 'success';
}

function envHealthText(runtime: TelegramAccountRuntimeView): string {
  if (runtime.coolingDown) return '冷却中';
  if (runtime.consecutiveFailures > 0) return `连续失败 ${runtime.consecutiveFailures} 次`;
  return '正常';
}

/** 运行态摘要（数据库账号行与环境变量账号区共用） */
function runtimeSummary(runtime: TelegramAccountRuntimeView): string {
  const parts = [
    `在飞 ${runtime.inflight}/${runtime.maxInflight}`,
    `成功率 ${formatSuccessRate(runtime.successRate)}`,
  ];
  if (runtime.coolingDown) parts.push(`冷却 ${formatCooldown(runtime.cooldownRemainingMs)}`);
  return parts.join(' · ');
}

/**
 * 账号池状态提示：用总览的 `pool` + `precheck` 区分具体原因，
 * 避免笼统地显示「账号池正常」而掩盖配置问题。
 */
const poolNotice = computed<{ theme: 'info' | 'warning' | 'success'; title: string; message: string } | null>(() => {
  const data = overview.value;
  if (!data) return null;
  const pool = data.pool;
  const primaryAccountId = pool?.primaryAccountId ?? null;

  // 1) 未配置环境变量主 Bot
  if (!primaryAccountId) {
    return {
      theme: 'info',
      title: '未配置环境变量主 Bot',
      message: '未设置 TELEGRAM_BOT_TOKEN：账号池中没有环境变量主 Bot，后台账号全部来自数据库。',
    };
  }

  // 2) 已配置但主 Bot 探测失败/不可用（precheck 失败，或冷却中/连续失败）
  const primaryPrecheck = data.precheck.find((item) => item.id === 'primary_bot');
  const primaryEnv = envAccounts.value.find((account) => account.primary);
  const primaryUnhealthy = Boolean(
    primaryEnv && (primaryEnv.runtime.coolingDown || primaryEnv.runtime.consecutiveFailures > 0),
  );
  if ((primaryPrecheck && !primaryPrecheck.ok) || primaryUnhealthy) {
    return {
      theme: 'warning',
      title: '环境变量主 Bot 当前不可用',
      message: primaryPrecheck && !primaryPrecheck.ok
        ? primaryPrecheck.hint
        : `主 Bot ${primaryAccountId} 探测失败或处于冷却（连续失败 ${primaryEnv?.runtime.consecutiveFailures ?? 0} 次），调度器已暂时摘除该账号。`,
    };
  }

  // 3) 被 FORCE_DISABLED 强制关闭 / 前置检查阻断
  if (data.feature.accountPoolForceDisabled) {
    return {
      theme: 'warning',
      title: '账号池已被环境变量强制关闭',
      message: 'FORCE_DISABLED 生效：面板无法开启账号池，请检查部署环境变量。',
    };
  }

  // 4) 账号池未生效：区分「功能关闭」与「已开启但无可用账号」
  if (!pool?.enabled) {
    const reason = pool?.inactiveReason ?? '';
    if (reason.includes('未解析到任何账号')) {
      return {
        theme: 'warning',
        title: '账号池已开启但没有可调度账号',
        message: reason,
      };
    }
    return {
      theme: 'info',
      title: '账号池未生效',
      message: reason || '账号池当前未启用。',
    };
  }

  // 全部正常：给出可核对的具体计数，而非笼统的「正常」
  return {
    theme: 'success',
    title: '账号池已生效',
    message: `池内共 ${pool.accountCount} 个账号（其中环境变量 ${pool.envAccountCount} 个）。`,
  };
});

/** 重新探测环境变量账号：成功后刷新列表/总览并提示结论 */
async function runEnvProbe(account: TelegramEnvAccountView) {
  if (envProbingId.value) return;
  envProbingId.value = account.id;
  try {
    const result = await probeEnvAccount(account.id);
    const conclusion = result.message || (result.probe.ok ? '环境变量账号探测通过' : '环境变量账号探测失败');
    if (result.probe.ok) {
      MessagePlugin.success(conclusion);
    } else {
      MessagePlugin.error(conclusion);
    }
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    envProbingId.value = null;
    // 探测结论会回写账号池运行态（健康/冷却）：无论成功失败都刷新
    await Promise.all([loadAccounts(), loadOverview()]);
  }
}

// ---------------- 轮换 ----------------

const rotateDialogVisible = ref(false);
const rotateSubmitting = ref(false);
const rotateAccountId = ref<string | null>(null);
const rotateType = ref<TelegramAccountType>('bot');
const rotateForm = reactive({
  token: '',
  primaryChatId: '',
  apiId: 1,
  apiHash: '',
  phoneNumber: '',
});

const rotateDialogHeader = computed(() => (rotateType.value === 'bot' ? '轮换 Bot Token' : '更新用户凭据'));

function openRotate(account: TelegramAccountView) {
  rotateAccountId.value = account.id;
  rotateType.value = account.type;
  rotateForm.token = '';
  rotateForm.primaryChatId = account.primaryChatId ?? '';
  rotateForm.apiId = 1;
  rotateForm.apiHash = '';
  rotateForm.phoneNumber = '';
  rotateDialogVisible.value = true;
}

async function submitRotate() {
  if (!rotateAccountId.value || rotateSubmitting.value) return;
  rotateSubmitting.value = true;
  try {
    if (rotateType.value === 'bot') {
      if (!rotateForm.token.trim()) {
        MessagePlugin.warning('请输入新的 Bot Token');
        return;
      }
      await rotateAccount(rotateAccountId.value, {
        token: rotateForm.token.trim(),
        primaryChatId: rotateForm.primaryChatId.trim() || undefined,
      });
      MessagePlugin.success('Bot 凭据已轮换');
    } else {
      await rotateAccount(rotateAccountId.value, {
        apiId: rotateForm.apiId,
        apiHash: rotateForm.apiHash.trim() || undefined,
        phoneNumber: rotateForm.phoneNumber.trim() || undefined,
      });
      MessagePlugin.success('用户账号凭据已更新，请重新完成授权');
    }
    rotateDialogVisible.value = false;
    rotateForm.token = '';
    rotateForm.apiHash = '';
    await Promise.all([loadAccounts(), loadOverview()]);
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    rotateSubmitting.value = false;
  }
}

// ---------------- 用户账号授权 ----------------

const authDialogVisible = ref(false);
const authAccountId = ref<string | null>(null);
const authStep = ref<'code' | 'verify'>('code');
const authPhoneNumber = ref('');
const authCode = ref('');
const authPassword = ref('');
const authPhoneMasked = ref<string | null>(null);
const authSending = ref(false);
const authVerifying = ref(false);

function openAuthorize(account: TelegramAccountView) {
  authAccountId.value = account.id;
  authStep.value = 'code';
  authPhoneNumber.value = '';
  authCode.value = '';
  authPassword.value = '';
  authPhoneMasked.value = null;
  authDialogVisible.value = true;
}

function closeAuthDialog() {
  authDialogVisible.value = false;
  // 验证码与密码绝不留在组件状态中
  authCode.value = '';
  authPassword.value = '';
}

async function advanceAuth() {
  if (!authAccountId.value) return;
  if (authStep.value === 'code') {
    authSending.value = true;
    try {
      const result = await startUserAuth(authAccountId.value, {
        phoneNumber: authPhoneNumber.value.trim() || undefined,
      });
      authPhoneMasked.value = result.phoneMasked;
      authStep.value = 'verify';
      MessagePlugin.success('验证码已发送');
    } catch (error) {
      MessagePlugin.error(getErrorMessage(error));
    } finally {
      authSending.value = false;
    }
    return;
  }

  if (!authCode.value.trim()) {
    MessagePlugin.warning('请输入验证码');
    return;
  }
  authVerifying.value = true;
  try {
    await verifyUserAuth(authAccountId.value, {
      code: authCode.value.trim(),
      password: authPassword.value || undefined,
    });
    MessagePlugin.success('授权成功');
    closeAuthDialog();
    await Promise.all([loadAccounts(), loadOverview()]);
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    authVerifying.value = false;
  }
}

// ---------------- 开关（账号池 / 镜像） ----------------

async function toggleAccountPool(enabled: boolean) {
  if ((overview.value?.feature.accountPoolEnabled ?? false) === enabled) return;
  const dialog = DialogPlugin.confirm({
    header: enabled ? '开启账号池' : '关闭账号池',
    body: enabled
      ? '开启后新任务将使用账号池调度。'
      : '关闭只阻止新镜像任务，不删除已备份文件；在途传输会正常收尾。',
    onConfirm: async () => {
      dialog.destroy();
      featureSaving.value = true;
      try {
        const result = await setAccountPoolEnabled(enabled);
        MessagePlugin.success(result.message);
        await loadOverview();
      } catch (error) {
        MessagePlugin.error(getErrorMessage(error));
      } finally {
        featureSaving.value = false;
      }
    },
    onClose: () => dialog.destroy(),
  });
}

async function toggleMirror(enabled: boolean) {
  if ((mirror.value?.feature.mirrorEnabled ?? false) === enabled) return;
  const dialog = DialogPlugin.confirm({
    header: enabled ? '开启镜像功能' : '关闭镜像功能',
    body: enabled
      ? '开启后新文件将按规则镜像到备份群。'
      : '关闭只阻止新任务，已开始的镜像会正常收尾，也不删除已备份内容。',
    onConfirm: async () => {
      dialog.destroy();
      featureSaving.value = true;
      try {
        const result = await setMirrorEnabled(enabled);
        MessagePlugin.success(result.message);
        await loadOverview();
      } catch (error) {
        MessagePlugin.error(getErrorMessage(error));
      } finally {
        featureSaving.value = false;
      }
    },
    onClose: () => dialog.destroy(),
  });
}

// ---------------- 历史补偿（阶段 3） ----------------

const emptyBackfill = (): MirrorBackfillJob => ({
  status: 'idle',
  mode: 'dry-run',
  limit: 0,
  scanned: 0,
  queued: 0,
  skipped: 0,
  sample: [],
  startedAt: null,
  updatedAt: '',
  finishedAt: null,
  lastError: null,
  cursor: null,
});

const backfill = ref<MirrorBackfillJob>(emptyBackfill());
const backfillSaving = ref(false);

/** 可发起新补偿的状态（未开始 / 已结束的任何结论） */
const backfillIdle = computed(() => ['idle', 'completed', 'cancelled', 'failed'].includes(backfill.value.status));

const BACKFILL_STATUS_TEXT: Record<MirrorBackfillStatus, string> = {
  idle: '未开始',
  running: '执行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
};

const BACKFILL_STATUS_THEME: Record<MirrorBackfillStatus, 'default' | 'primary' | 'success' | 'warning' | 'danger'> = {
  idle: 'default',
  running: 'primary',
  paused: 'warning',
  completed: 'success',
  cancelled: 'default',
  failed: 'danger',
};

const backfillStatusText = computed(() => BACKFILL_STATUS_TEXT[backfill.value.status] ?? '未知');
const backfillStatusTheme = computed(() => BACKFILL_STATUS_THEME[backfill.value.status] ?? 'default');

let backfillTimer: ReturnType<typeof setInterval> | null = null;

/** 仅在执行中轮询进度：暂停/结束时立即停表，避免空转请求 */
function syncBackfillPolling(): void {
  if (backfill.value.status === 'running' && !backfillTimer) {
    backfillTimer = setInterval(() => void loadBackfill(), 3000);
    return;
  }
  if (backfill.value.status !== 'running' && backfillTimer) {
    clearInterval(backfillTimer);
    backfillTimer = null;
  }
}

async function loadBackfill(signal?: AbortSignal): Promise<void> {
  try {
    backfill.value = await fetchMirrorBackfill(signal);
    syncBackfillPolling();
  } catch {
    // 补偿状态接口失败不阻断页面其余部分（账号与任务才是主操作面）
  }
}

async function runBackfill(mode: 'dry-run' | 'apply'): Promise<void> {
  const dialog = DialogPlugin.confirm({
    header: mode === 'dry-run' ? '评估历史补偿影响面' : '开始历史补偿',
    body: mode === 'dry-run'
      ? '仅统计将被补偿的历史文件数量，不入队、不产生任何转发。'
      : '补偿会为历史文件补建「主群搬运 + 用户账号中继到各镜像群」的任务：按批限速执行、可随时暂停或取消；'
        + '全程服务端转发，不产生文件字节流量；重复运行不会产生重复备份。',
    onConfirm: async () => {
      dialog.destroy();
      backfillSaving.value = true;
      try {
        const result = await startMirrorBackfill({ mode, limit: 200 });
        MessagePlugin.success(result.message);
        backfill.value = result.job;
        syncBackfillPolling();
      } catch (error) {
        MessagePlugin.error(getErrorMessage(error));
      } finally {
        backfillSaving.value = false;
      }
    },
    onClose: () => dialog.destroy(),
  });
}

async function controlBackfill(action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  backfillSaving.value = true;
  try {
    const result = action === 'pause'
      ? await pauseMirrorBackfill()
      : action === 'resume'
        ? await resumeMirrorBackfill()
        : await cancelMirrorBackfill();
    MessagePlugin.success(result.message);
    backfill.value = result.job;
    syncBackfillPolling();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    backfillSaving.value = false;
  }
}

// ---------------- 镜像规则（多规则） ----------------

interface MirrorRuleFormState {
  id: string | null;
  name: string;
  sourceChatId: string;
  targetChatId: string;
  preferredAccountId: string;
  includeWebUploads: boolean;
  includeBotInboundFiles: boolean;
}

function emptyMirrorForm(): MirrorRuleFormState {
  return {
    id: null,
    name: '',
    sourceChatId: '',
    targetChatId: '',
    preferredAccountId: '',
    includeWebUploads: true,
    includeBotInboundFiles: false,
  };
}

const mirrorForm = reactive<MirrorRuleFormState>(emptyMirrorForm());
/** 最近一次权限测试结论（附带规则名，便于在结果区标明属于哪条规则） */
const mirrorTestResult = ref<(MirrorRuleTestResult & { ruleName: string }) | null>(null);
const testingRuleId = ref<string | null>(null);
const togglingRuleId = ref<string | null>(null);
const savingMirror = ref(false);

const mirrorModeHint =
  '扩散只有一条链路：持有源消息的 Bot 先转发到主群，再由用户账号从主群服务端转发到各镜像群，'
  + '最后由镜像群内的 Bot 认领副本；全程零字节重传（字节二次传输恒为 0），'
  + '不存在 Bot 重新上传，也不作为失败降级手段。';

/** 重置为「新建规则」空表单 */
function resetMirrorForm() {
  Object.assign(mirrorForm, emptyMirrorForm());
}

function openCreateRule() {
  resetMirrorForm();
}

function openEditRule(rule: MirrorRule) {
  mirrorForm.id = rule.id;
  mirrorForm.name = rule.name ?? '';
  mirrorForm.sourceChatId = rule.sourceChatId ?? '';
  mirrorForm.targetChatId = rule.targetChatId ?? '';
  mirrorForm.preferredAccountId = rule.preferredAccountId ?? '';
  mirrorForm.includeWebUploads = rule.includeWebUploads;
  mirrorForm.includeBotInboundFiles = rule.includeBotInboundFiles;
}

/** 事件范围文案（未勾选任何事件时不扩散） */
function ruleEventScopeText(rule: MirrorRule): string {
  const parts: string[] = [];
  if (rule.includeWebUploads) parts.push('Web 上传');
  if (rule.includeBotInboundFiles) parts.push('Bot 入站');
  return parts.length > 0 ? parts.join(' / ') : '未选择事件';
}

function ruleTestTheme(status: MirrorRule['lastTestStatus']): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'ok') return 'success';
  if (status === 'failed') return 'danger';
  return 'default';
}

/** 权限测试单条规则（探测主群/镜像群可达性，不产生真实镜像任务） */
async function runMirrorTest(rule: MirrorRule) {
  testingRuleId.value = rule.id;
  try {
    const result = await testMirrorRule(rule.id);
    mirrorTestResult.value = { ...result, ruleName: rule.name };
    if (result.status === 'ok') {
      MessagePlugin.success(result.summary || '测试通过');
    } else {
      MessagePlugin.error(result.summary || '测试失败');
    }
    await loadMirror();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    testingRuleId.value = null;
  }
}

/**
 * 保存规则：`mirrorForm.id` 为空走新建，否则更新。
 *
 * 载荷不含已删除的 `mode` / `fallbackMode`（后端 `forbidNonWhitelisted` 会直接 400）。
 */
async function saveMirrorRule() {
  if (!mirrorForm.sourceChatId.trim() || !mirrorForm.targetChatId.trim()) {
    MessagePlugin.warning('请填写主群与镜像群');
    return;
  }
  savingMirror.value = true;
  try {
    const payload: UpdateMirrorRuleInput = {
      name: mirrorForm.name.trim() || undefined,
      sourceChatId: mirrorForm.sourceChatId.trim(),
      targetChatId: mirrorForm.targetChatId.trim(),
      preferredAccountId: mirrorForm.preferredAccountId.trim(),
      includeWebUploads: mirrorForm.includeWebUploads,
      includeBotInboundFiles: mirrorForm.includeBotInboundFiles,
    };
    const result = mirrorForm.id
      ? await updateMirrorRule(mirrorForm.id, payload)
      : await createMirrorRule(payload);
    MessagePlugin.success(result.message);
    await loadMirror();
    resetMirrorForm();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    savingMirror.value = false;
  }
}

/**
 * 启用/停用单条规则。
 *
 * 启用前必须通过一次权限测试；前端先提示，后端仍会二次校验（主群一致性 / 测试结论）。
 * 失败原因通过 `getErrorMessage` 展示，不静默吞掉。
 */
async function toggleRuleEnabled(rule: MirrorRule, enabled: boolean) {
  if (enabled && rule.lastTestStatus !== 'ok') {
    MessagePlugin.warning('启用规则前请先通过「测试权限」');
    return;
  }
  togglingRuleId.value = rule.id;
  try {
    const result = await setMirrorRuleEnabled(rule.id, enabled);
    MessagePlugin.success(result.message);
    await loadMirror();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
    // 失败时以服务端状态为准回填开关，避免开关停留在用户点击后的假状态
    await loadMirror();
  } finally {
    togglingRuleId.value = null;
  }
}

/** 删除规则（启用中或有在途任务时后端返回 400，错误原因需展示给管理员） */
function confirmDeleteRule(rule: MirrorRule) {
  const dialog = DialogPlugin.confirm({
    header: '删除镜像规则',
    body: `确定删除规则「${rule.name || '未命名规则'}」吗？删除后该镜像群不再参与副本扩散，已备份内容不会被删除。`,
    theme: 'danger',
    onConfirm: async () => {
      dialog.destroy();
      try {
        const result = await deleteMirrorRule(rule.id);
        MessagePlugin.success(result.message);
        if (mirrorForm.id === rule.id) resetMirrorForm();
        await loadMirror();
      } catch (error) {
        MessagePlugin.error(getErrorMessage(error));
      }
    },
    onClose: () => dialog.destroy(),
  });
}

// ---------------- 任务列表 ----------------

const taskRows = ref<MirrorTaskListItem[]>([]);
const tasksLoading = ref(false);
const taskFilters = reactive<{
  status: TelegramMirrorTaskStatus | '';
  ownerId: string;
  accountId: string;
}>({
  status: '',
  ownerId: '',
  accountId: '',
});
const taskPagination = reactive({ current: 1, pageSize: 20, total: 0 });

const taskColumns = [
  { colKey: 'ownerId', title: '文件 ID', width: 200 },
  { colKey: 'targetAccountId', title: '执行账号', width: 150 },
  { colKey: 'targetMessageId', title: '目标消息', width: 120 },
  { colKey: 'attempts', title: '重试', width: 70 },
  { colKey: 'lastError', title: '最后错误', width: 220 },
  { colKey: 'time', title: '时间', width: 160 },
  { colKey: 'operations', title: '操作', width: 140 },
];

/**
 * 单个镜像群分组。
 *
 * 分组键是**镜像群**（`targetChatId`）而不是规则 id：同一镜像群可能由规则重建，
 * 但运维关心的是「哪个群现在有问题」，按群聚合才不会把多群的失败混成一锅。
 */
interface TaskGroup {
  key: string;
  chatId: string | null;
  /** 规则名（能解析到时给出，否则退化为规则 id 或「未知规则」） */
  ruleLabel: string;
  items: MirrorTaskListItem[];
  failedCount: number;
  blockedCount: number;
  pendingCount: number;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  lastErrorAt: string | null;
}

/** 进行中的任务状态（用于分组标题的「进行中」计数） */
const PENDING_TASK_STATUSES: TelegramMirrorTaskStatus[] = ['queued', 'running', 'retrying'];

/** 镜像任务按镜像群聚合（同群失败原因只在组头汇总，不跨群混排） */
const taskGroups = computed<TaskGroup[]>(() => {
  const ruleNames = new Map<string, string>(
    (mirror.value?.rules ?? []).map((rule) => [rule.id, rule.name || '未命名规则']),
  );
  const groups = new Map<string, TaskGroup>();

  for (const item of taskRows.value) {
    const chatId = (item.targetChatId || '').trim() || null;
    const key = chatId ?? '__unassigned__';
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        chatId,
        ruleLabel: ruleNames.get(item.ruleId) ?? (item.ruleId ? `规则 ${item.ruleId}` : '未知规则'),
        items: [],
        failedCount: 0,
        blockedCount: 0,
        pendingCount: 0,
        lastErrorCode: null,
        lastErrorSummary: null,
        lastErrorAt: null,
      };
      groups.set(key, group);
    }
    group.items.push(item);
    if (item.status === 'failed') group.failedCount += 1;
    if (item.status === 'blocked') group.blockedCount += 1;
    if (PENDING_TASK_STATUSES.includes(item.status)) group.pendingCount += 1;
    // 组内最近一次失败原因：只取时间更新的一条，避免多群/多条互相覆盖
    if (item.lastErrorSummary && group.lastErrorSummary === null) {
      group.lastErrorCode = item.lastErrorCode;
      group.lastErrorSummary = item.lastErrorSummary;
      group.lastErrorAt = item.updatedAt || item.createdAt;
    }
  }

  // 有问题的群排在前面，其余按群 ID 稳定排序
  return [...groups.values()].sort((left, right) => {
    const bad = (group: TaskGroup) => group.failedCount + group.blockedCount;
    if (bad(right) !== bad(left)) return bad(right) - bad(left);
    return (left.chatId ?? '').localeCompare(right.chatId ?? '');
  });
});

/** 分组标题标签主题：有失败/阻塞为 danger，有进行中为 primary，其余 default */
function taskGroupTheme(group: TaskGroup): TagTheme {
  if (group.failedCount + group.blockedCount > 0) return 'danger';
  if (group.pendingCount > 0) return 'primary';
  return 'default';
}

const TASK_STATUS_TEXT: Record<TelegramMirrorTaskStatus, string> = {
  queued: '排队中',
  running: '执行中',
  retrying: '重试中',
  succeeded: '成功',
  failed: '失败',
  blocked: '阻塞',
  cancelled: '已取消',
};

type TagTheme = 'default' | 'primary' | 'success' | 'warning' | 'danger';

const TASK_STATUS_THEME: Record<TelegramMirrorTaskStatus, TagTheme> = {
  queued: 'default',
  running: 'primary',
  retrying: 'warning',
  succeeded: 'success',
  failed: 'danger',
  blocked: 'danger',
  cancelled: 'default',
};

function taskStatusText(status: TelegramMirrorTaskStatus): string {
  return TASK_STATUS_TEXT[status] ?? status;
}

function taskStatusTheme(status: TelegramMirrorTaskStatus): TagTheme {
  return TASK_STATUS_THEME[status] ?? 'default';
}

function isRunning(row: MirrorTaskListItem): boolean {
  return row.status === 'running';
}

function canRetry(row: MirrorTaskListItem): boolean {
  return row.status === 'failed' || row.status === 'blocked' || row.status === 'cancelled';
}

function canCancel(row: MirrorTaskListItem): boolean {
  return row.status === 'queued' || row.status === 'retrying';
}

async function loadTasks() {
  tasksLoading.value = true;
  try {
    const { items, total } = await fetchMirrorTasks({
      status: taskFilters.status || undefined,
      ownerId: taskFilters.ownerId.trim() || undefined,
      accountId: taskFilters.accountId.trim() || undefined,
      page: taskPagination.current,
      pageSize: taskPagination.pageSize,
    });
    taskRows.value = items;
    taskPagination.total = total;
  } catch {
    MessagePlugin.error('任务列表加载失败，已保留上次数据');
  } finally {
    tasksLoading.value = false;
  }
}

function onTaskFilterChange() {
  taskPagination.current = 1;
  loadTasks();
}

function onTaskPageChange(pageInfo: { current: number; pageSize: number }) {
  taskPagination.current = pageInfo.current;
  taskPagination.pageSize = pageInfo.pageSize;
  loadTasks();
}

async function doRetryTask(row: MirrorTaskListItem) {
  try {
    const result = await retryMirrorTask(row.id);
    MessagePlugin.success(result.message);
    await Promise.all([loadTasks(), loadMirror()]);
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function doCancelTask(row: MirrorTaskListItem) {
  if (row.status === 'running') {
    MessagePlugin.warning('执行中不可取消');
    return;
  }
  try {
    const result = await cancelMirrorTask(row.id);
    MessagePlugin.success(result.message);
    await Promise.all([loadTasks(), loadMirror()]);
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

// ---------------- 副本扩散策略（阶段 2/3 观测面） ----------------

const replication = ref<ReplicationAuditReport | null>(null);
const replicationLoading = ref(false);
const replicationSaving = ref(false);
const replicationStale = ref(false);
const replicationForm = reactive({ desiredReplicas: 2 });

const preflightLoading = ref(false);
const preflightReport = ref<RelayPreflightReport | null>(null);
const expandedAttemptId = ref<string | null>(null);
const attemptDetailLoading = ref(false);
const attemptDetails = reactive<Record<string, ReplicationAttemptDetailView>>({});
const retryingAttemptId = ref<string | null>(null);
/** 最近一次手动重试结果（原样展示后端口径，0 重排不粉饰成功） */
const retryResult = ref<ReplicationRetryResult | null>(null);

const capacity = computed(() => replication.value?.capacity ?? null);
const coverage = computed(() => replication.value?.coverage ?? {
  scannedFiles: 0,
  satisfied: 0,
  unsatisfied: 0,
  truncated: false,
  missingSamples: [],
});

/** 中继能力快照（缺失时全部记为「未检查」，绝不渲染成健康态） */
const relayCapability = computed<RelayCapabilitySnapshot>(() => replication.value?.strategy.capability ?? {
  relayEnabledByConfig: false,
  userClientAvailable: false,
  userClientUnavailableReason: null,
  enabledAuthorizedUserCount: 0,
  resolvedTargetChatIdPreview: null,
  sourceChatIdPreview: null,
  sourceChatReadable: 'not_checked',
  targetChatWritable: 'not_checked',
  botsCanReceiveRelay: 'not_checked',
  checkedAt: null,
  checkStatus: 'not_checked',
  notes: [],
});

const relayMetricsView = computed(() => replication.value?.relayMetrics ?? null);
const largeFileCoverage = computed(() => replication.value?.largeFileCoverage ?? null);
const recentAttempts = computed(() => replication.value?.recentAttempts ?? []);
const observability = computed(() => replication.value?.observability ?? {
  degraded: false,
  reason: null,
  since: null,
  writeFailures: 0,
});

/** 当前展开轮次的详情（避免模板里重复下标访问） */
const activeAttemptDetail = computed(() => (
  expandedAttemptId.value ? attemptDetails[expandedAttemptId.value] ?? null : null
));

/** 失败原因分布条形的最大计数（用于计算相对宽度） */
const maxFailureCount = computed(() => (
  relayMetricsView.value?.failureReasons.reduce((max, item) => Math.max(max, item.count), 0) ?? 0
));

const capabilityStatusText = computed(() => {
  const status = relayCapability.value.checkStatus;
  if (status === 'ok') return '检查通过';
  if (status === 'partial') return '部分通过';
  if (status === 'failed') return '检查失败';
  return '未检查';
});

const replicaColumns = [
  { colKey: 'accountId', title: '账号', width: 150 },
  { colKey: 'enabled', title: '启用', width: 80 },
  { colKey: 'storageConfigured', title: '存储 Chat', width: 100 },
  { colKey: 'health', title: '健康', width: 130 },
  { colKey: 'cooldown', title: '冷却剩余', width: 110 },
  { colKey: 'inflight', title: '在飞', width: 90 },
  { colKey: 'readyCopies', title: '已登记副本', width: 110 },
  { colKey: 'eligible', title: '当前可调度', width: 110 },
  { colKey: 'reasons', title: '排除原因' },
];

/** 期望副本数的配置来源文案（运行时配置优先，env 仅作回退） */
function targetSourceText(source: 'system' | 'env' | 'default'): string {
  if (source === 'system') return '运行时配置';
  if (source === 'env') return '环境变量（回退值）';
  return '内置默认值';
}

/** 探测结论三态文案：未检查必须与「通过」区分 */
function relayCheckText(status: RelayCheckStatus): string {
  if (status === 'ok') return '通过';
  if (status === 'failed') return '失败';
  return '未检查';
}

function relayCheckClass(status: RelayCheckStatus): string {
  if (status === 'ok') return 'check-ok';
  if (status === 'failed') return 'check-failed';
  return 'check-unknown';
}

function preflightStatusText(status: RelayPreflightReport['status']): string {
  if (status === 'ok') return '通过';
  if (status === 'partial') return '部分通过';
  return '失败';
}

/** 轮次状态 → 标签主题（成功/警告/失败/进行中四类语义） */
function attemptStatusTheme(status: ReplicationAttemptStatus): 'success' | 'warning' | 'danger' | 'primary' | 'default' {
  if (status === 'succeeded') return 'success';
  if (status === 'partial_success' || status === 'claim_timeout') return 'warning';
  if (status.startsWith('blocked_') || status === 'retryable_failed') return 'danger';
  if (status === 'relay_running' || status === 'waiting_claims') return 'primary';
  return 'default';
}

function attemptDotClass(status: ReplicationAttemptStatus): string {
  if (status === 'succeeded') return 'dot-success';
  if (status === 'partial_success' || status === 'claim_timeout') return 'dot-warning';
  if (status.startsWith('blocked_') || status === 'retryable_failed') return 'dot-danger';
  return 'dot-muted';
}

/** 失败原因键 → 中文文案（未知键原样展示，避免静默丢信息） */
function failureReasonText(reason: UserRelayFailureReason): string {
  return RELAY_FAILURE_REASON_LABELS[reason] ?? reason;
}

/** 失败原因分布条形宽度（相对窗口内最大计数；仅宽度，不涉及颜色） */
function failureBarWidth(count: number): string {
  const max = maxFailureCount.value;
  if (max <= 0) return '0%';
  return `${Math.max(6, Math.round((count / max) * 100))}%`;
}

/** ready 账号数分布：`2 路 × 3 个文件` 形式（空分布给 `—`，不伪造 0 路） */
function readyDistributionText(counts: number[]): string {
  if (counts.length === 0) return '—';
  const buckets = new Map<number, number>();
  for (const value of counts) buckets.set(value, (buckets.get(value) ?? 0) + 1);
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ready, files]) => `${ready} 路 × ${files} 个文件`)
    .join('，');
}

/** 耗时：毫秒 / 秒 / 分钟三档（null 一律 `—`，不显示 0ms 假装有数据） */
function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}min`;
}

/** 比率：低样本时显示「样本不足」而不是数字（避免把 1/1 读成 100% 健康） */
function formatRate(value: number | null, sampleSufficient: boolean): string {
  if (!sampleSufficient || value === null || !Number.isFinite(value)) return '样本不足';
  return `${Math.round(value * 100)}%`;
}

function formatWindowText(windowMs: number): string {
  if (!windowMs || windowMs <= 0) return '窗口未知';
  const hours = windowMs / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(windowMs / 60_000))} 分钟`;
  if (hours < 48) return `${Math.round(hours)} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

async function loadReplicationAudit() {
  replicationLoading.value = true;
  try {
    const data = await fetchReplicationAudit();
    replication.value = data;
    replicationStale.value = false;
    // 仅在加载成功时回填表单，避免失败时把输入框重置成空值
    replicationForm.desiredReplicas = data.target.configured;
  } catch {
    // 失败时保留上次数据并显式标记过期，不渲染伪造的全零健康态
    replicationStale.value = replication.value !== null;
    MessagePlugin.error('副本扩散审计加载失败，已保留上次数据');
  } finally {
    replicationLoading.value = false;
  }
}

async function saveReplicationTarget() {
  replicationSaving.value = true;
  try {
    const result = await updateReplicationTarget(replicationForm.desiredReplicas);
    MessagePlugin.success(result.message);
    await loadReplicationAudit();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    replicationSaving.value = false;
  }
}

/**
 * 中继能力预检。
 *
 * `dryRun=true` 只做只读检查（不产生任何 Telegram 消息）；
 * `dryRun=false` 会向目标群发送一条受控测试消息，调用前必须二次确认。
 */
async function runRelayPreflightCheck(dryRun: boolean) {
  preflightLoading.value = true;
  try {
    preflightReport.value = await runRelayPreflight({ dryRun });
    if (dryRun) {
      MessagePlugin.success('只读预检完成，未产生任何 Telegram 消息');
    } else if (preflightReport.value.sentTestMessage) {
      MessagePlugin.warning('预检完成：已向目标群发送一条受控测试消息');
    } else {
      MessagePlugin.info('预检完成：未发出测试消息（检查项见报告）');
    }
    // 预检会刷新能力快照，重新拉取审计让策略卡同步最新结论
    await loadReplicationAudit();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    preflightLoading.value = false;
  }
}

function confirmPreflightWithTestMessage() {
  const dialog = DialogPlugin.confirm({
    header: '发送测试消息探测目标群可写性',
    body: '该操作会通过一个 Bot 向目标群发送一条受控测试消息（会真实出现在群里，可忽略），用于验证目标群可写性。是否继续？',
    confirmBtn: '发送并探测',
    onConfirm: async () => {
      dialog.destroy();
      await runRelayPreflightCheck(false);
    },
    onClose: () => dialog.destroy(),
  });
}

/** 展开/收起失败详情（详情按轮次缓存，状态变化后由重试路径主动失效） */
async function toggleAttempt(row: ReplicationAttemptView) {
  if (expandedAttemptId.value === row.id) {
    expandedAttemptId.value = null;
    return;
  }
  expandedAttemptId.value = row.id;
  if (attemptDetails[row.id]) return;
  attemptDetailLoading.value = true;
  try {
    attemptDetails[row.id] = await fetchReplicationAttemptDetail(row.id);
  } catch (error) {
    expandedAttemptId.value = null;
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    attemptDetailLoading.value = false;
  }
}

/** 手动重试（二次确认 + 幂等提示；只走用户账号中继，不提供策略选择） */
function confirmRetryAttempt(row: ReplicationAttemptView) {
  const dialog = DialogPlugin.confirm({
    header: '重试扩散轮次',
    body: `将把 ${row.ownerLabel} 在该镜像群上的扩散重新交给镜像任务队列（重置在途终态任务、补建缺失任务）。`
      + '不新建执行路径，也不会产生重复群消息；重试记录会写入审计。是否继续？',
    confirmBtn: '重试',
    onConfirm: async () => {
      dialog.destroy();
      await doRetryAttempt(row);
    },
    onClose: () => dialog.destroy(),
  });
}

/**
 * 手动重试：结果**如实展示**（`requeued`/`created`/`ruleIds`），不粉饰成功。
 *
 * 0 重排（`requeued + created === 0`）说明该镜像群上已有在途任务，
 * 这时必须显示「无需重试」而不是成功提示，否则会误导管理员反复点击。
 */
async function doRetryAttempt(row: ReplicationAttemptView) {
  retryingAttemptId.value = row.id;
  try {
    const result = await retryReplicationAttempt(row.id);
    retryResult.value = result;
    if (result.requeued + result.created > 0) {
      MessagePlugin.success(result.message);
    } else {
      MessagePlugin.warning('无需重试：该镜像群上已有在途任务，未产生新的排队或补建');
    }
    // 该轮次状态已变化，丢弃详情缓存避免展示过期建议
    delete attemptDetails[row.id];
    expandedAttemptId.value = null;
    await loadReplicationAudit();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    retryingAttemptId.value = null;
  }
}

// ---------------- 数据加载 ----------------

async function loadOverview() {
  try {
    const data = await fetchAccountOverview();
    overview.value = data;
  } catch {
    // 加载失败不得用空值覆盖服务端配置，保持上次数据并提示
    MessagePlugin.error('账号池总览加载失败，已保留上次数据');
  }
}

async function loadMirror() {
  try {
    const data = await fetchMirrorOverview();
    mirror.value = data;
  } catch {
    MessagePlugin.error('镜像规则加载失败，已保留上次数据');
  }
}

async function loadAll() {
  await Promise.all([
    loadOverview(),
    loadMirror(),
    loadAccounts(),
    loadTasks(),
    loadBackfill(),
    loadReplicationAudit(),
  ]);
}

onMounted(() => {
  loadAll();
});
</script>

<style scoped>
.telegram-accounts-page {
  padding: 0;
}

/* ---------- 能力状态条 ---------- */
.status-card {
  padding: var(--space-4);
}

.status-switches {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--space-4);
}

.status-switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}

.status-switch-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.status-switch-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.status-switch-meta {
  font-size: 12px;
  color: var(--text-secondary);
}

.precheck-list {
  margin-top: var(--space-4);
}

.precheck-items {
  margin: 0;
  padding-left: var(--space-4);
  font-size: 13px;
  line-height: 1.6;
}

/* ---------- 总览卡区 ---------- */
.overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.stat-card .stat-sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 6px;
  line-height: 1.5;
}

.error-value {
  font-size: 18px;
}

.error-summary {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ---------- 副本扩散策略 ---------- */
.replica-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.replica-input {
  margin: var(--space-2) 0;
}

.replica-warn {
  color: var(--color-warning);
}

.replica-missing {
  margin-top: var(--space-4);
}

.replica-missing h3 {
  margin: 0 0 var(--space-2);
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 600;
}

.replica-missing ul {
  margin: 0;
  padding-left: var(--space-4);
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.7;
}

.replica-notes {
  margin: var(--space-4) 0 0;
  padding-left: var(--space-4);
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.7;
}

/* ---------- 副本扩散：数据新鲜度与策略卡 ---------- */
.stale-flag {
  font-size: 12px;
  color: var(--color-warning);
  border: 1px solid var(--color-warning);
  border-radius: var(--radius-sm);
  padding: 1px 6px;
}

.section-hint-inline {
  font-size: 12px;
  color: var(--text-tertiary);
}

.replica-strategy {
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  margin-bottom: var(--space-4);
}

.strategy-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: var(--space-3);
}

.strategy-claim {
  font-size: 12px;
  color: var(--text-secondary);
}

.strategy-kv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-2) var(--space-4);
  margin: 0;
}

/* 审计口径说明：目标副本数只用于覆盖率展示，不驱动扩散 */
.strategy-audit-note {
  margin: var(--space-3) 0;
  padding: var(--space-2) var(--space-3);
  border-left: 3px solid var(--border-accent);
  background: var(--color-bg-surface);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.7;
}

.kv-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.kv-item dt {
  font-size: 12px;
  color: var(--text-tertiary);
}

.kv-item dd {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin: 0;
  font-size: 13px;
  color: var(--text-primary);
}

.kv-note {
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
}

.check-badges {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-3);
}

.check-badge {
  font-size: 12px;
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  background: var(--color-bg-surface);
}

.check-ok {
  color: var(--color-success);
  border-color: var(--color-success);
  background: var(--color-success-soft);
}

.check-failed {
  color: var(--color-danger);
  border-color: var(--color-danger);
  background: var(--color-danger-soft);
}

.check-unknown {
  color: var(--text-tertiary);
}

.strategy-blockers {
  margin: var(--space-3) 0 0;
  padding: var(--space-2) var(--space-3) var(--space-2) var(--space-6);
  border-left: 3px solid var(--color-warning);
  background: var(--color-warning-soft);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.7;
}

.preflight-report {
  margin-top: var(--space-3);
  border-top: 1px dashed var(--border-default);
  padding-top: var(--space-3);
}

.preflight-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-bottom: var(--space-2);
}

.preflight-checks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.preflight-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  font-size: 13px;
}

/* ---------- 副本扩散：指标卡 ---------- */
.replica-grid-split {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

@media (min-width: 1024px) {
  .replica-grid-split {
    grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  }
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: var(--space-2);
  margin: var(--space-2) 0 var(--space-3);
}

.metric-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
}

.metric-label {
  font-size: 12px;
  color: var(--text-tertiary);
}

.metric-value {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.bar-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: var(--space-3);
}

.bar-row {
  display: grid;
  grid-template-columns: 140px 1fr 32px;
  align-items: center;
  gap: var(--space-2);
  font-size: 12px;
}

.bar-label {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar-track {
  display: block;
  height: 8px;
  border-radius: 4px;
  background: var(--color-bg-hover);
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  background: var(--color-danger);
  border-radius: 4px;
}

.bar-count {
  text-align: right;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.metric-contract {
  margin: var(--space-3) 0 0;
  font-size: 12px;
  color: var(--text-tertiary);
  border-top: 1px dashed var(--border-default);
  padding-top: var(--space-2);
}

/* ---------- 副本扩散：大文件覆盖率 ---------- */
.tier-block {
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-default);
  border-left: 3px solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: var(--color-bg-elevated);
}

.tier-secondary {
  border-left-color: var(--border-strong);
}

.tier-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.tier-label {
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.tier-missing {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-4);
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.7;
}

/* ---------- 副本扩散：事件时间线 ---------- */
.replica-attempts {
  margin-top: var(--space-5);
}

.attempts-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.attempts-head h3 {
  margin: 0 0 var(--space-2);
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 600;
}

.timeline {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.timeline-item {
  position: relative;
  display: flex;
  gap: var(--space-3);
  padding: var(--space-2) 0 var(--space-2) var(--space-4);
}

.timeline-item::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border-default);
}

.timeline-dot {
  position: absolute;
  left: 0;
  top: 12px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--text-tertiary);
}

.dot-success {
  background: var(--color-success);
}

.dot-warning {
  background: var(--color-warning);
}

.dot-danger {
  background: var(--color-danger);
}

.dot-muted {
  background: var(--text-tertiary);
}

.timeline-body {
  flex: 1;
  min-width: 0;
}

.timeline-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  font-size: 13px;
}

.timeline-meta {
  font-size: 12px;
  color: var(--text-secondary);
}

.timeline-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
}

/* 手动重试结果：0 重排必须显示为「无需重试」而不是成功 */
.retry-result {
  margin-bottom: var(--space-3);
}

.retry-result-message {
  margin: 0;
  font-size: 13px;
  color: var(--text-primary);
}

.retry-result-metrics {
  margin: var(--space-2) 0;
  padding-left: var(--space-4);
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.7;
}

.retry-result-hint {
  margin: 0 0 var(--space-2);
  font-size: 12px;
  color: var(--color-warning);
  line-height: 1.7;
}

.attempt-detail {
  margin-top: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--color-bg-elevated);
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-3);
}

.detail-item p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.detail-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.detail-timeline {
  list-style: none;
  margin: var(--space-3) 0 0;
  padding: var(--space-2) 0 0;
  border-top: 1px dashed var(--border-default);
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.detail-timeline li {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  flex-wrap: wrap;
}

/* ---------- 区块通用 ---------- */
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: var(--space-3);
}

.section-header h3 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
}

.section-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.section-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0 0 var(--space-3);
}

.table-filters {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: var(--space-4);
}

.filter-input {
  width: 200px;
}

.filter-select {
  width: 150px;
}

.table-scroll {
  overflow-x: auto;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-strong {
  font-weight: 600;
  color: var(--text-primary);
}

.cell-mono {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
}

.cell-muted {
  color: var(--text-tertiary);
}

.cell-error {
  color: var(--color-danger);
  font-size: 12px;
}

.row-actions {
  display: flex;
  gap: var(--space-1);
  flex-wrap: wrap;
}

.disabled-action {
  font-size: 12px;
  color: var(--text-disabled);
}

.pagination-row {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-4);
}

/* ---------- 镜像规则 ---------- */
.mirror-rule-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.mirror-rule-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}

.mirror-rule-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.mirror-rule-meta {
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
}

/* 规则行的启用开关与操作区（一条规则一个镜像群，独立启停） */
.mirror-rule-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-top: var(--space-1);
}

.mirror-rule-switch {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.mirror-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-3);
  align-items: end;
  margin-bottom: var(--space-4);
}

.mirror-form-head {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.field-row {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.field-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.field-actions {
  flex-direction: row;
  gap: var(--space-2);
}

.mirror-events {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: var(--space-4);
}

.test-result {
  margin-top: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--color-bg-elevated);
}

.test-result-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.test-result-summary {
  font-size: 13px;
  color: var(--text-primary);
}

.test-details {
  list-style: none;
  margin: var(--space-3) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.test-detail {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  font-size: 13px;
}

.test-detail-role {
  font-weight: 600;
  color: var(--text-primary);
}

.test-detail-text {
  color: var(--text-secondary);
}

/* ---------- 镜像任务：按镜像群分组 ---------- */
.task-groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.task-group {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--color-bg-elevated);
  padding: var(--space-3);
}

.task-group-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-bottom: var(--space-2);
}

.task-group-chat {
  word-break: break-all;
}

.task-group-error {
  margin: 0 0 var(--space-2);
  font-size: 12px;
  color: var(--color-danger);
  line-height: 1.7;
  word-break: break-all;
}

/* ---------- 移动端卡片 ---------- */
.mobile-card-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.mobile-account-card,
.mobile-task-card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}

.mobile-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-bottom: var(--space-2);
}

.mobile-card-meta {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
  word-break: break-all;
}

.mobile-card-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-3);
}

.empty-hint {
  text-align: center;
  padding: var(--space-6) 0;
  color: var(--text-secondary);
  font-size: 13px;
}

/* ---------- 环境变量账号（只读） ---------- */
.env-accounts {
  margin: var(--space-4) 0;
  padding: var(--space-4);
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}

.env-accounts-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-bottom: var(--space-3);
}

.env-accounts-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.env-account-list {
  list-style: none;
  margin: var(--space-3) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.env-account-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-3);
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
}

.env-account-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.env-account-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.env-account-id {
  font-family: var(--font-mono);
  font-size: 13px;
}

.env-account-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--space-2) var(--space-3);
  margin: 0;
}

.env-meta-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.env-meta-item dt {
  font-size: 11px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.env-meta-item dd {
  margin: 0;
  font-size: 13px;
  color: var(--text-primary);
  word-break: break-all;
}

.env-account-warn {
  margin: 0;
  font-size: 12px;
  color: var(--color-warning);
}

.env-account-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.cell-note {
  font-size: 12px;
  color: var(--text-tertiary);
}

/* ---------- 弹窗表单 ---------- */
.dialog-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.dialog-hint {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.audit-entry {
  margin: var(--space-2) 0 var(--space-6);
  font-size: 13px;
}

.audit-entry a {
  color: var(--seed-primary);
  text-decoration: none;
}

.audit-entry a:hover {
  text-decoration: underline;
}

@media (max-width: 768px) {
  .filter-input,
  .filter-select {
    width: 100%;
  }

  .pagination-row {
    justify-content: center;
  }
}
</style>
