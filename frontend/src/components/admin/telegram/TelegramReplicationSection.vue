<template>
  <section id="tg-replication" class="card" aria-label="副本扩散策略">
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
            <span class="cell-strong">{{ userCopyCount }}</span>
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

      <!-- 筛选：全部=报告窗口；其余走整表查询（避免把「窗口内没有」误读成「整表没有」） -->
      <div class="attempts-filters">
        <t-select
          v-model="attemptFilter"
          class="filter-select"
          aria-label="扩散轮次筛选"
          @change="onAttemptFilterChange"
        >
          <t-option value="" :label="`全部（最近 ${ATTEMPT_WINDOW_LIMIT} 条）`" />
          <t-option value="failed" label="未完成（含阻塞）" />
          <t-option value="claim_timeout" label="认领超时" />
          <t-option value="retryable" label="只看可重试" />
        </t-select>
        <span class="section-hint">
          「未完成」= 失败 / 阻塞 / 部分成功（认领不足）；筛选作用于整表最近记录，不受上方窗口限制。
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

      <div v-if="attemptsLoading" class="empty-hint">筛选结果加载中…</div>
      <ul v-else-if="attemptSource.length > 0" id="replica-attempt-timeline" class="timeline">
        <li v-for="attempt in visibleAttempts" :key="attempt.id" class="timeline-item">
          <span class="timeline-dot" :class="attemptDotClass(attempt.status)" />
          <div class="timeline-body">
            <div class="timeline-row">
              <span class="cell-mono">{{ attempt.ownerLabel }}</span>
              <t-tag :theme="attemptStatusTheme(attempt.status)" variant="light" size="small">
                {{ attempt.statusLabel }}
              </t-tag>
              <span class="timeline-meta">{{ formatTime(attempt.createdAt) }}</span>
              <span class="timeline-meta">{{ attemptTriggerText(attempt.triggeredBy) }}</span>
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

      <div v-else-if="!attemptsError" class="empty-hint">
        {{ attemptFilter === '' ? '窗口内没有扩散轮次记录' : '当前筛选下没有记录' }}
      </div>

      <!-- 查询失败 / 后端降级都必须显式提示：静默空列表会被误读成「没有记录」 -->
      <div v-if="attemptsError" class="stat-sub replica-warn">
        筛选查询未完整返回：{{ attemptsError }}。请修正筛选条件或稍后重试，不要据此判断「没有记录」；
        {{ attemptsFiltered.length > 0 ? '下方列表为上一次成功查询的结果。' : '' }}
      </div>

      <!-- 折叠控制：默认只看最近 N 条，展开不额外请求（同一份快照） -->
      <div v-if="!attemptsLoading && attemptSource.length > ATTEMPT_COLLAPSE_LIMIT" class="attempts-footer">
        <t-button
          variant="text"
          size="small"
          :aria-expanded="attemptsExpanded"
          aria-controls="replica-attempt-timeline"
          @click="attemptsExpanded = !attemptsExpanded"
        >
          {{ attemptsExpanded
            ? `收起（只显示最近 ${ATTEMPT_COLLAPSE_LIMIT} 条）`
            : `展开全部（共 ${attemptSource.length} 条，另有 ${hiddenAttemptCount} 条）` }}
        </t-button>
      </div>

      <div v-if="attemptsTruncated && attemptFilter !== ''" class="stat-sub replica-warn">
        筛选结果已截断：仅显示最近 {{ ATTEMPT_FILTER_LIMIT }} 条，请在下方「镜像任务」按文件 ID 定位，或用更窄的筛选继续排查。
      </div>
    </div>

    <ul v-if="replication" class="replica-notes">
      <li v-for="note in replication.notes" :key="note">{{ note }}</li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { DialogPlugin } from 'tdesign-vue-next/es/dialog';
import MessagePlugin from '@/utils/message';
import { getErrorMessage } from '@/utils/error';
import {
  FAILED_ATTEMPT_STATUSES,
  RELAY_FAILURE_REASON_LABELS,
  RETRYABLE_ATTEMPT_STATUSES,
  fetchReplicationAttemptDetail,
  fetchReplicationAttempts,
  fetchReplicationAudit,
  retryReplicationAttempt,
  runRelayPreflight,
  updateReplicationTarget,
  type RelayCapabilitySnapshot,
  type RelayCheckStatus,
  type RelayPreflightReport,
  type ReplicationAttemptDetailView,
  type ReplicationAttemptStatus,
  type ReplicationAttemptView,
  type ReplicationAuditReport,
  type ReplicationRetryResult,
  type UserRelayFailureReason,
} from '@/api/telegram-accounts';
import { formatCooldown, formatTime } from '@/utils/telegram-format';

defineProps<{
  userCopyCount: number;
}>();

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

const ATTEMPT_COLLAPSE_LIMIT = 5;
const ATTEMPT_WINDOW_LIMIT = 50;
const ATTEMPT_FILTER_LIMIT = 50;

type AttemptFilterKey = '' | 'failed' | 'claim_timeout' | 'retryable';
const attemptFilter = ref<AttemptFilterKey>('');
const attemptsFiltered = ref<ReplicationAttemptView[]>([]);
const attemptsLoading = ref(false);
let attemptsRequestVersion = 0;
const attemptsTruncated = ref(false);
const attemptsError = ref<string | null>(null);
const attemptsExpanded = ref(false);

const capacity = computed(() => replication.value?.capacity ?? null);
const coverage = computed(() => replication.value?.coverage ?? {
  scannedFiles: 0,
  satisfied: 0,
  unsatisfied: 0,
  truncated: false,
  missingSamples: [],
});

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

const attemptSource = computed<ReplicationAttemptView[]>(() => (
  attemptFilter.value === '' ? recentAttempts.value : attemptsFiltered.value
));
const visibleAttempts = computed<ReplicationAttemptView[]>(() => (
  attemptsExpanded.value
    ? attemptSource.value
    : attemptSource.value.slice(0, ATTEMPT_COLLAPSE_LIMIT)
));
const hiddenAttemptCount = computed(() => (
  Math.max(0, attemptSource.value.length - ATTEMPT_COLLAPSE_LIMIT)
));
const observability = computed(() => replication.value?.observability ?? {
  degraded: false,
  reason: null,
  since: null,
  writeFailures: 0,
});

const activeAttemptDetail = computed(() => (
  expandedAttemptId.value ? attemptDetails[expandedAttemptId.value] ?? null : null
));

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

function targetSourceText(source: 'system' | 'env' | 'default'): string {
  if (source === 'system') return '运行时配置';
  if (source === 'env') return '环境变量（回退值）';
  return '内置默认值';
}

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

function attemptTriggerText(triggeredBy: ReplicationAttemptView['triggeredBy']): string {
  if (triggeredBy === 'manual') return '触发：手动重试';
  if (triggeredBy === 'lazy') return '触发：下载期（历史）';
  return '触发：入库或补建';
}

async function onAttemptFilterChange() {
  attemptsExpanded.value = false;
  attemptsTruncated.value = false;
  attemptsError.value = null;
  if (attemptFilter.value === '') {
    attemptsRequestVersion += 1;
    attemptsFiltered.value = [];
    attemptsLoading.value = false;
    return;
  }
  await loadFilteredAttempts();
}

async function loadFilteredAttempts() {
  const filterKey = attemptFilter.value;
  if (filterKey === '') return;
  const requestVersion = ++attemptsRequestVersion;
  attemptsLoading.value = true;
  try {
    const result = await fetchReplicationAttempts({
      status: attemptFilterStatuses(filterKey),
      limit: ATTEMPT_FILTER_LIMIT,
    });
    if (requestVersion !== attemptsRequestVersion || attemptFilter.value !== filterKey) return;
    attemptsFiltered.value = result.items;
    attemptsTruncated.value = result.truncated;
    attemptsError.value = result.observability.degraded
      ? `观测数据不完整${result.observability.reason ? `：${result.observability.reason}` : ''}`
      : null;
  } catch (error) {
    if (requestVersion !== attemptsRequestVersion || attemptFilter.value !== filterKey) return;
    attemptsError.value = getErrorMessage(error);
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    if (requestVersion === attemptsRequestVersion && attemptFilter.value === filterKey) {
      attemptsLoading.value = false;
    }
  }
}

function attemptFilterStatuses(
  filter: Exclude<AttemptFilterKey, ''>,
): ReplicationAttemptStatus | ReplicationAttemptStatus[] {
  switch (filter) {
    case 'retryable':
      return RETRYABLE_ATTEMPT_STATUSES;
    case 'failed':
      return FAILED_ATTEMPT_STATUSES;
    case 'claim_timeout':
      return 'claim_timeout';
  }
}

function failureReasonText(reason: UserRelayFailureReason): string {
  return RELAY_FAILURE_REASON_LABELS[reason] ?? reason;
}

function failureBarWidth(count: number): string {
  const max = maxFailureCount.value;
  if (max <= 0) return '0%';
  return `${Math.max(6, Math.round((count / max) * 100))}%`;
}

function readyDistributionText(counts: number[]): string {
  if (counts.length === 0) return '—';
  const buckets = new Map<number, number>();
  for (const value of counts) buckets.set(value, (buckets.get(value) ?? 0) + 1);
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ready, files]) => `${ready} 路 × ${files} 个文件`)
    .join('，');
}

function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}min`;
}

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
    replicationForm.desiredReplicas = data.target.configured;
    if (attemptFilter.value !== '') await loadFilteredAttempts();
  } catch {
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
    delete attemptDetails[row.id];
    expandedAttemptId.value = null;
    await loadReplicationAudit();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    retryingAttemptId.value = null;
  }
}

onMounted(() => {
  void loadReplicationAudit();
});
</script>

<style scoped>
.replica-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
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
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: var(--space-2) var(--space-4);
  margin: 0;
}

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
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 110px), 1fr));
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

.attempts-filters {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin: var(--space-3) 0 0;
}

.attempts-filters .section-hint {
  margin: 0;
}

.filter-select {
  width: 100%;
}

@media (min-width: 769px) {
  .filter-select {
    width: 150px;
  }
}

.attempts-footer {
  display: flex;
  justify-content: center;
  margin-top: var(--space-2);
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

.dot-success { background: var(--color-success); }
.dot-warning { background: var(--color-warning); }
.dot-danger { background: var(--color-danger); }
.dot-muted { background: var(--text-tertiary); }

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
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
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

.cell-strong { font-weight: 600; color: var(--text-primary); }
.cell-mono { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); }
.cell-muted { color: var(--text-tertiary); }
.cell-error { color: var(--color-danger); font-size: 12px; }

.stat-card .stat-sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 6px;
  line-height: 1.5;
}
</style>
