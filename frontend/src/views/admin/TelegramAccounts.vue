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
        <div class="value">{{ ruleStateText }}</div>
        <div class="stat-sub">权限测试：{{ testStatusText(mirror?.test?.status ?? mirror?.rule?.lastTestStatus) }}</div>
        <div class="stat-sub">源群 {{ mirror?.rule?.sourceChatId || '—' }} → 备份群 {{ mirror?.rule?.targetChatId || '—' }}</div>
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
                未配置存储 Chat：仅参与下载回源，不会被选为上传/镜像目标。
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
              <t-button variant="text" theme="danger" size="small" @click="confirmDelete(row)">删除</t-button>
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
            <t-button variant="text" theme="danger" size="small" @click="confirmDelete(row)">删除</t-button>
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

    <!-- 镜像配置卡 -->
    <section class="card" aria-label="镜像配置">
      <div class="section-header">
        <h3>镜像配置</h3>
        <t-switch
          :value="mirror?.rule?.enabled ?? false"
          :disabled="!canEnableRule"
          @change="(v: boolean) => toggleRuleEnabled(Boolean(v))"
        />
      </div>
      <p v-if="!canEnableRule" class="section-hint">启用规则前请先通过一次「测试权限」。</p>

      <div class="mirror-form">
        <label class="field">
          <span class="field-label">源群（主存储群）</span>
          <t-input v-model="mirrorForm.sourceChatId" placeholder="例如 -1001234567890" autocomplete="off" name="mirror-source" />
        </label>
        <label class="field">
          <span class="field-label">备份群</span>
          <t-input v-model="mirrorForm.targetChatId" placeholder="例如 -1000987654321" autocomplete="off" name="mirror-target" />
        </label>
        <div class="field field-actions">
          <t-button variant="outline" :loading="testing" @click="runMirrorTest">测试权限</t-button>
          <t-button theme="primary" :loading="savingMirror" @click="saveMirrorRule">保存配置</t-button>
        </div>
      </div>

      <div class="mirror-mode">
        <span class="field-label">镜像模式</span>
        <t-radio-group v-model="mirrorForm.mode" variant="default-filled">
          <t-radio-button value="auto">自动</t-radio-button>
          <t-radio-button value="bot_upload">仅 Bot 上传</t-radio-button>
          <t-radio-button value="user_copy">仅用户复制</t-radio-button>
        </t-radio-group>
      </div>

      <div class="mirror-events">
        <span class="field-label">事件范围</span>
        <t-checkbox v-model="mirrorForm.includeWebUploads">Web 上传</t-checkbox>
        <t-checkbox v-model="mirrorForm.includeBotInboundFiles">Bot 入站</t-checkbox>
      </div>

      <t-alert theme="info" :message="mirrorModeHint" />

      <div v-if="mirrorTestResult" class="test-result">
        <div class="test-result-head">
          <t-tag :theme="mirrorTestResult.status === 'ok' ? 'success' : 'danger'" variant="light">
            {{ mirrorTestResult.status === 'ok' ? '测试通过' : '测试失败' }}
          </t-tag>
          <span class="test-result-summary">{{ mirrorTestResult.summary }}</span>
        </div>
        <ul class="test-details">
          <li v-for="(detail, index) in mirrorTestResult.details" :key="index" class="test-detail">
            <span class="test-detail-role">{{ detail.chat === 'source' ? '源群' : '备份群' }}</span>
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
        补偿会把历史文件字节再次上传到备份群：按批扫描（每批 20 个、间隔 1 秒），可随时暂停或取消；
        重复运行不会产生重复备份（任务幂等键保证），也不会改变现有下载链接。
      </p>

      <t-alert v-if="backfill.lastError" theme="warning" :message="backfill.lastError" />
      <div v-if="backfill.sample.length > 0" class="field-row">
        <span class="section-hint">样本文件 ID（最多 20 个）：</span>
        <code v-for="sampleId in backfill.sample" :key="sampleId" class="cell-mono">{{ sampleId }}</code>
      </div>
    </section>

    <!-- 任务列表区 -->
    <section class="card" aria-label="镜像任务">
      <div class="section-header">
        <h3>镜像任务</h3>
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
        <t-select v-model="taskFilters.mode" class="filter-select" placeholder="模式">
          <t-option value="" label="全部模式" />
          <t-option value="bot_upload" label="Bot 上传" />
          <t-option value="user_copy" label="用户复制" />
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

      <div v-if="!isMobile" class="table-scroll">
        <t-table
          :data="taskRows"
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
          <template #mode="{ row }">{{ modeText(row.mode) }}</template>
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
        <div v-for="row in taskRows" :key="row.id" class="mobile-task-card">
          <div class="mobile-card-head">
            <span class="cell-mono">{{ row.ownerId }}</span>
            <t-tag :theme="taskStatusTheme(row.status)" variant="light">{{ taskStatusText(row.status) }}</t-tag>
          </div>
          <div class="mobile-card-meta">模式：{{ modeText(row.mode) }}</div>
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
        <div v-if="!tasksLoading && taskRows.length === 0" class="empty-hint">暂无镜像任务</div>
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
  cancelMirrorBackfill,
  cancelMirrorTask,
  createBotAccount,
  createUserAccount,
  deleteAccount,
  fetchAccountOverview,
  fetchMirrorBackfill,
  fetchAccounts,
  fetchMirrorOverview,
  fetchMirrorTasks,
  pauseMirrorBackfill,
  probeEnvAccount,
  resumeMirrorBackfill,
  retryMirrorTask,
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
  verifyUserAuth,
  type AccountPoolOverview,
  type MirrorBackfillJob,
  type MirrorBackfillStatus,
  type MirrorOverview,
  type MirrorRuleTestResult,
  type MirrorTaskListItem,
  type MirrorTaskSummary,
  type TelegramAccountRuntimeView,
  type TelegramAccountStatus,
  type TelegramAccountType,
  type TelegramAccountView,
  type TelegramEnvAccountView,
  type TelegramMirrorMode,
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

const ruleStateText = computed(() => {
  if (!mirror.value?.rule) return '未配置';
  return mirror.value.rule.enabled ? '已启用' : '未启用';
});

/** 只有通过权限测试且规则已配置时才允许启用 */
const canEnableRule = computed(() => {
  const rule = mirror.value?.rule;
  if (!rule) return false;
  if (rule.enabled) return true;
  return rule.lastTestStatus === 'ok';
});

// ---------------- 账号列表 ----------------

const accountTab = ref<TelegramAccountType>('bot');
const accounts = ref<TelegramAccountView[]>([]);
const accountsLoading = ref(false);
const accountKeyword = ref('');
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
      ? '仅统计将被补偿的历史文件数量，不入队、不产生任何上传。'
      : '补偿会把历史文件字节再次上传到备份群：按批限速执行、可随时暂停或取消；重复运行不会产生重复备份。',
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

// ---------------- 镜像配置 ----------------

const mirrorForm = reactive<{
  sourceChatId: string;
  targetChatId: string;
  mode: TelegramMirrorMode;
  includeWebUploads: boolean;
  includeBotInboundFiles: boolean;
}>({
  sourceChatId: '',
  targetChatId: '',
  mode: 'bot_upload',
  includeWebUploads: true,
  includeBotInboundFiles: false,
});

const mirrorTestResult = ref<MirrorRuleTestResult | null>(null);
const testing = ref(false);
const savingMirror = ref(false);

const mirrorModeHint = 'Bot 模式会上传两次；用户模式要求用户账号可访问源消息，文件字节只上传一次。';

/** 用服务端规则回填表单；仅在请求成功时调用，避免加载失败覆盖已编辑内容 */
function applyMirrorRule() {
  const rule = mirror.value?.rule;
  if (!rule) return;
  mirrorForm.sourceChatId = rule.sourceChatId ?? '';
  mirrorForm.targetChatId = rule.targetChatId ?? '';
  mirrorForm.mode = rule.mode;
  mirrorForm.includeWebUploads = rule.includeWebUploads;
  mirrorForm.includeBotInboundFiles = rule.includeBotInboundFiles;
}

async function runMirrorTest() {
  testing.value = true;
  try {
    const result = await testMirrorRule();
    mirrorTestResult.value = result;
    if (result.status === 'ok') {
      MessagePlugin.success(result.summary || '测试通过');
    } else {
      MessagePlugin.error(result.summary || '测试失败');
    }
    await loadMirror();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    testing.value = false;
  }
}

async function saveMirrorRule() {
  savingMirror.value = true;
  try {
    const payload: UpdateMirrorRuleInput = {
      sourceChatId: mirrorForm.sourceChatId.trim(),
      targetChatId: mirrorForm.targetChatId.trim(),
      mode: mirrorForm.mode,
      includeWebUploads: mirrorForm.includeWebUploads,
      includeBotInboundFiles: mirrorForm.includeBotInboundFiles,
    };
    const result = await updateMirrorRule(payload);
    MessagePlugin.success(result.message);
    await loadMirror();
    applyMirrorRule();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    savingMirror.value = false;
  }
}

async function toggleRuleEnabled(enabled: boolean) {
  if ((mirror.value?.rule?.enabled ?? false) === enabled) return;
  if (enabled && !canEnableRule.value) {
    MessagePlugin.warning('请先通过「测试权限」再启用规则');
    return;
  }
  try {
    const result = await setMirrorRuleEnabled(enabled);
    MessagePlugin.success(result.message);
    await loadMirror();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

// ---------------- 任务列表 ----------------

const taskRows = ref<MirrorTaskListItem[]>([]);
const tasksLoading = ref(false);
const taskFilters = reactive<{
  status: TelegramMirrorTaskStatus | '';
  mode: TelegramMirrorMode | '';
  ownerId: string;
  accountId: string;
}>({
  status: '',
  mode: '',
  ownerId: '',
  accountId: '',
});
const taskPagination = reactive({ current: 1, pageSize: 20, total: 0 });

const taskColumns = [
  { colKey: 'ownerId', title: '文件 ID', width: 200 },
  { colKey: 'mode', title: '模式', width: 100 },
  { colKey: 'targetAccountId', title: '执行账号', width: 150 },
  { colKey: 'targetMessageId', title: '目标消息', width: 120 },
  { colKey: 'attempts', title: '重试', width: 70 },
  { colKey: 'lastError', title: '最后错误', width: 220 },
  { colKey: 'time', title: '时间', width: 160 },
  { colKey: 'operations', title: '操作', width: 140 },
];

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

function modeText(mode: string): string {
  if (mode === 'bot_upload') return 'Bot 上传';
  if (mode === 'user_copy') return '用户复制';
  return mode || '—';
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
      mode: taskFilters.mode || undefined,
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
    // 仅在尚无用户编辑时回填；已有编辑内容不覆盖
    applyMirrorRule();
  } catch {
    MessagePlugin.error('镜像配置加载失败，已保留上次数据');
  }
}

async function loadAll() {
  await Promise.all([
    loadOverview(),
    loadMirror(),
    loadAccounts(),
    loadTasks(),
    loadBackfill(),
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

/* ---------- 镜像配置 ---------- */
.mirror-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-3);
  align-items: end;
  margin-bottom: var(--space-4);
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

.mirror-mode,
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
