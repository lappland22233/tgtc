<template>
  <t-dialog
    :visible="visible"
    header="处理重复文件"
    :width="isMobile ? '100%' : '600px'"
    :footer="false"
    destroy-on-close
    @close="handleCancel"
  >
    <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 12px;">
      发现 {{ conflicts.length }} 个文件与目标目录中的既有文件同名，请逐项选择覆盖或跳过。
    </div>

    <!-- 快捷操作 -->
    <div style="display: flex; gap: 8px; margin-bottom: 12px;">
      <t-button size="small" variant="outline" @click="applyAll('overwrite')">
        全部覆盖
      </t-button>
      <t-button size="small" variant="outline" @click="applyAll('skip')">
        全部跳过
      </t-button>
      <span v-if="pendingCount > 0" style="margin-left: auto; font-size: 12px; color: var(--text-tertiary); align-self: center;">
        待选择 {{ pendingCount }} 项
      </span>
    </div>

    <!-- 冲突列表（可滚动） -->
    <div style="max-height: 320px; overflow-y: auto;">
      <div
        v-for="(conflict, idx) in conflicts"
        :key="idx"
        style="padding: 10px 12px; background: var(--bg-secondary, var(--color-bg-surface)); border-radius: 8px; margin-bottom: 8px; border: 1px solid var(--border-color, var(--border-default));"
      >
        <div style="font-weight: 500; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
          {{ conflict.item.file.name }}
        </div>
        <div
          v-if="conflict.item.relativePath"
          style="font-size: 12px; color: var(--text-tertiary); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"
        >
          {{ conflict.item.relativePath }}
        </div>
        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
          {{ formatSize(conflict.existingSize) }} → {{ formatSize(conflict.item.file.size) }}
        </div>
        <div v-if="conflict.overwriteBlocked" style="font-size: 12px; color: var(--color-warning); margin-top: 4px;">
          既有文件处理中，本次按新文件上传
        </div>
        <t-radio-group
          v-if="!conflict.overwriteBlocked"
          :value="decisions[idx] ?? undefined"
          size="small"
          style="margin-top: 8px;"
          @change="(val: unknown) => setDecision(idx, val)"
        >
          <t-radio value="overwrite">覆盖</t-radio>
          <t-radio value="skip">跳过</t-radio>
        </t-radio-group>
      </div>
    </div>

    <!-- 底部按钮 -->
    <div style="margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end;">
      <t-button variant="outline" @click="handleCancel">
        取消
      </t-button>
      <t-button theme="primary" :disabled="pendingCount > 0" @click="handleConfirm">
        确认
      </t-button>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useMobile } from '../composables/useMobile';
import { formatSize } from '../utils/format';
import type { ConflictItem, ConflictDecision, ConflictDecisionEntry } from '../utils/conflict-detector';

const props = defineProps<{
  visible: boolean;
  conflicts: ConflictItem[];
}>();

const emit = defineEmits<{
  confirm: [decisions: ConflictDecisionEntry[]];
  cancel: [];
}>();

const isMobile = useMobile();

/** 每项决策（与 conflicts 同序），null 表示未选择（防误覆盖，默认不预选） */
const decisions = ref<Array<ConflictDecision | null>>([]);

/** 打开/冲突列表变化时重置决策状态 */
watch(
  () => [props.visible, props.conflicts] as const,
  ([visible]) => {
    if (visible) {
      decisions.value = props.conflicts.map(() => null);
    }
  },
  { immediate: true },
);

const pendingCount = computed(() =>
  props.conflicts.filter((c, i) => !c.overwriteBlocked && decisions.value[i] == null).length,
);

function setDecision(idx: number, val: unknown) {
  if (val === 'overwrite' || val === 'skip') {
    decisions.value[idx] = val;
  }
}

function applyAll(decision: ConflictDecision) {
  decisions.value = props.conflicts.map((c) => (c.overwriteBlocked ? null : decision));
}

function handleConfirm() {
  if (pendingCount.value > 0) return;
  const result: ConflictDecisionEntry[] = [];
  props.conflicts.forEach((conflict, i) => {
    // 处理中不可覆盖的项强制按新文件上传（等效跳过覆盖，但会正常入队新建）
    const decision: ConflictDecision = conflict.overwriteBlocked ? 'skip' : (decisions.value[i] ?? 'skip');
    result.push({ conflict, decision });
  });
  emit('confirm', result);
}

function handleCancel() {
  emit('cancel');
}
</script>
