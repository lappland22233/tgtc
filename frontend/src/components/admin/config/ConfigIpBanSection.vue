<template>
  <section id="config-ipban" class="card mt-5">
    <div class="section-header">
      <h3>IP 封禁管理</h3>
      <t-button theme="danger" @click="showBanDialog = true">+ 封禁IP</t-button>
    </div>

    <t-table :data="bannedIPs" :columns="ipColumns" row-key="id" hover>
      <template #isPermanent="{ row }">
        <t-tag :theme="row.isPermanent ? 'danger' : 'warning'" size="small">
          {{ row.isPermanent ? '永久' : '临时' }}
        </t-tag>
      </template>
      <template #expiresAt="{ row }">
        {{ row.expiresAt ? formatDate(row.expiresAt) : '-' }}
      </template>
      <template #operations="{ row }">
        <t-button size="small" theme="success" variant="text" @click="emit('unban', row.ip)">
          解封
        </t-button>
      </template>
    </t-table>

    <t-dialog v-model:visible="showBanDialog" header="封禁IP" @confirm="emit('ban')">
      <t-form layout="vertical">
        <t-form-item label="IP地址" name="ip">
          <t-input v-model="banForm.ip" placeholder="请输入要封禁的IP地址" autocomplete="off" name="config-ban-ip" />
        </t-form-item>
        <t-form-item label="封禁原因" name="reason">
          <t-input v-model="banForm.reason" placeholder="可选" autocomplete="off" name="config-ban-reason" />
        </t-form-item>
        <t-form-item label="封禁类型">
          <t-radio-group v-model="banForm.permanent">
            <t-radio :value="false">临时封禁</t-radio>
            <t-radio :value="true">永久封禁</t-radio>
          </t-radio-group>
        </t-form-item>
        <t-form-item v-if="!banForm.permanent" label="封禁时长">
          <div class="flex items-center gap-2">
            <div class="cfg-duration-input">
              <t-input-number v-model="banForm.durationHours" :min="1" :max="720" />
            </div>
            <span class="text-[13px] text-ink-muted">小时</span>
          </div>
        </t-form-item>
      </t-form>
    </t-dialog>
  </section>
</template>

<script setup lang="ts">
import type { BanIpFormState, BannedIpRecord } from './types';

const showBanDialog = defineModel<boolean>('showBanDialog', { required: true });
const banForm = defineModel<BanIpFormState>('banForm', { required: true });

defineProps<{
  bannedIPs: BannedIpRecord[];
  ipColumns: Array<{ colKey: string; title: string; width?: string }>;
  formatDate: (date: string) => string;
}>();

const emit = defineEmits<{
  ban: [];
  unban: [ip: string];
}>();
</script>

<style scoped>
.cfg-duration-input :deep(.t-input-number) {
  width: 120px;
}
</style>
