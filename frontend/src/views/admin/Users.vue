<template>
  <div>
    <div class="page-header">
      <h1>用户管理</h1>
      <p>管理系统所有用户账号</p>
    </div>

    <div class="card">
      <div style="display: flex; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 12px;">
        <t-input v-model="searchEmail" placeholder="搜索用户邮箱..." style="width: 300px;" @enter="searchUsers" autocomplete="off" name="admin-search-email" />
        <t-button theme="primary" @click="showCreateDialog = true">+ 创建用户</t-button>
      </div>

      <t-table v-if="!isMobile" :data="users" :columns="columns" row-key="id" hover>
        <template #role="{ row }">
          <t-tag :theme="getRoleTheme(row.role)" size="small">
            {{ getRoleText(row.role) }}
          </t-tag>
        </template>
        <template #isBanned="{ row }">
          <t-tag :theme="row.isBanned ? 'danger' : 'success'" size="small">
            {{ row.isBanned ? '已封禁' : '正常' }}
          </t-tag>
        </template>
        <template #lastLoginAt="{ row }">
          {{ row.lastLoginAt ? formatDate(row.lastLoginAt) : '从未登录' }}
        </template>
        <template #operations="{ row }">
          <t-button
            v-if="row.role !== 'super_admin' && !isSelf(row.id)"
            size="small"
            theme="warning"
            variant="text"
            @click="toggleBan(row)"
          >
            {{ row.isBanned ? '解封' : '封禁' }}
          </t-button>
          <t-button
            v-if="row.role === 'user'"
            size="small"
            theme="primary"
            variant="text"
            @click="grantAdmin(row)"
          >
            设为管理员
          </t-button>
          <t-button
            v-else-if="row.role === 'admin'"
            size="small"
            theme="default"
            variant="text"
            @click="demoteAdmin(row)"
          >
            取消管理员
          </t-button>
          <t-button
            v-if="row.role !== 'super_admin' && !isSelf(row.id)"
            size="small"
            theme="danger"
            variant="text"
            @click="deleteUser(row.id)"
          >
            删除
          </t-button>
        </template>
      </t-table>

      <!-- 移动端：卡片列表 -->
      <div v-if="isMobile" class="mobile-card-list">
        <div v-for="user in users" :key="user.id" class="mobile-user-card">
          <div>
            <strong>{{ user.email }}</strong>
            <div style="display: flex; gap: 6px; margin-top: 4px;">
              <t-tag :theme="getRoleTheme(user.role)" size="small">{{ getRoleText(user.role) }}</t-tag>
              <t-tag :theme="user.isBanned ? 'danger' : 'success'" size="small">{{ user.isBanned ? '已封禁' : '正常' }}</t-tag>
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
              最后登录: {{ user.lastLoginAt ? formatDate(user.lastLoginAt) : '从未登录' }}
            </div>
            <div style="font-size: 12px; color: var(--text-secondary);">
              注册时间: {{ formatDate(user.createdAt) }}
            </div>
          </div>
          <div style="display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap;">
            <t-button
              v-if="user.role !== 'super_admin' && !isSelf(user.id)"
              size="small"
              theme="warning"
              variant="outline"
              @click="toggleBan(user)"
            >
              {{ user.isBanned ? '解封' : '封禁' }}
            </t-button>
            <t-button
              v-if="user.role === 'user'"
              size="small"
              theme="primary"
              variant="outline"
              @click="grantAdmin(user)"
            >
              设为管理员
            </t-button>
            <t-button
              v-else-if="user.role === 'admin'"
              size="small"
              theme="default"
              variant="outline"
              @click="demoteAdmin(user)"
            >
              取消管理员
            </t-button>
            <t-button
              v-if="user.role !== 'super_admin' && !isSelf(user.id)"
              size="small"
              theme="danger"
              variant="outline"
              @click="deleteUser(user.id)"
            >
              删除
            </t-button>
          </div>
        </div>
      </div>

      <div style="margin-top: 16px; display: flex; justify-content: center;">
        <t-pagination
          v-model="page"
          :total="total"
          :page-size="20"
          @change="fetchUsers"
        />
      </div>
    </div>

    <t-dialog v-model:visible="showCreateDialog" header="创建用户" :on-confirm="createUser">
      <t-form :data="createForm" :rules="createFormRules" layout="vertical" label-width="0">
        <t-form-item label="邮箱" name="email">
          <t-input v-model="createForm.email" placeholder="请输入邮箱" autocomplete="off" name="admin-create-email" />
        </t-form-item>
        <t-form-item label="密码" name="password">
          <t-input v-model="createForm.password" type="password" placeholder="请输入密码" autocomplete="new-password" />
        </t-form-item>
        <t-form-item label="角色" name="role">
          <t-select v-model="createForm.role" :options="roleOptions" />
        </t-form-item>
      </t-form>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { DialogPlugin } from 'tdesign-vue-next';
import MessagePlugin from '@/utils/message';
import { useMobile } from '../../composables/useMobile';
import { api, useAuthStore } from '../../stores/auth';
import { getErrorMessage } from '../../utils/error';

// 当前登录用户（G15-25）：用于禁止管理员对自己执行封禁/删除，避免自我锁定
const authStore = useAuthStore();
const isSelf = (id: string) => authStore.user?.id === id;

const users = ref<{ id: string; email: string; role: string; isBanned: boolean; emailVerified: boolean; createdAt: string; lastLoginAt?: string }[]>([]);
const total = ref(0);
const page = ref(1);
const searchEmail = ref('');
const showCreateDialog = ref(false);
const createForm = ref({ email: '', password: '', role: 'user' });

// 创建用户前端校验（G15-26）：邮箱格式 + 密码最小长度 + 必填，避免空值/弱密码提交
const createFormRules: Record<string, { required?: boolean; validator?: (val: string) => boolean; message?: string; type?: 'error' | 'warning' }[]> = {
  email: [
    { required: true, message: '请输入邮箱', type: 'error' },
    {
      validator: (val: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val || ''),
      message: '邮箱格式不正确',
      type: 'error',
    },
  ],
  password: [
    { required: true, message: '请输入密码', type: 'error' },
    { validator: (val: string) => (val || '').length >= 6, message: '密码至少 6 位', type: 'error' },
  ],
  role: [{ required: true, message: '请选择角色', type: 'error' }],
};

/** 手动校验创建表单（不依赖 t-form ref 的 validate 方法，避免类型耦合） */
function validateCreateForm(): boolean {
  const email = createForm.value.email.trim();
  if (!email) { MessagePlugin.warning('请输入邮箱'); return false; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { MessagePlugin.warning('邮箱格式不正确'); return false; }
  const password = createForm.value.password;
  if (!password) { MessagePlugin.warning('请输入密码'); return false; }
  if (password.length < 6) { MessagePlugin.warning('密码至少 6 位'); return false; }
  return true;
}

const isMobile = useMobile();

const roleOptions = [
  { label: '普通用户', value: 'user' },
  { label: '管理员', value: 'admin' },
];

const columns = [
  { colKey: 'email', title: '邮箱', width: '200' },
  { colKey: 'role', title: '角色', width: '120' },
  { colKey: 'isBanned', title: '状态', width: '100' },
  { colKey: 'lastLoginAt', title: '最后登录', width: '150' },
  { colKey: 'createdAt', title: '注册时间', width: '150' },
  { colKey: 'operations', title: '操作', width: '200' },
];

function getRoleText(role: string) {
  const map: Record<string, string> = { super_admin: '超级管理员', admin: '管理员', user: '普通用户' };
  return map[role] || role;
}

function getRoleTheme(role: string) {
  const map: Record<string, string> = { super_admin: 'warning', admin: 'primary', user: 'default' };
  return map[role] || 'default';
}

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('zh-CN');
}

async function fetchUsers() {
  try {
    const res = await api.get('/users', { params: { page: page.value } });
    users.value = res.data.data.users;
    total.value = res.data.data.total;
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error) || '加载用户列表失败');
  }
}

async function searchUsers() {
  if (!searchEmail.value) {
    page.value = 1;
    fetchUsers();
    return;
  }
  try {
    page.value = 1;
    const res = await api.get('/users', { params: { page: 1, search: searchEmail.value } });
    users.value = res.data.data.users;
    total.value = res.data.data.total;
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error) || '搜索用户失败');
  }
}

/**
 * 封禁/解封用户：先二次确认（G15-06）。
 * 封禁时附带可选原因（用于对话框说明；后端暂不持久化 reason，仅提交 isBanned）。
 */
function toggleBan(row: { id: string; email: string; isBanned: boolean }) {
  const banning = !row.isBanned;
  const confirmDialog = DialogPlugin.confirm({
    header: banning ? '封禁用户' : '解封用户',
    body: banning
      ? `确定要封禁用户 "${row.email}" 吗？封禁后该用户将无法登录系统。`
      : `确定要解封用户 "${row.email}" 吗？解封后该用户可恢复正常登录。`,
    theme: banning ? 'warning' : 'default',
    confirmBtn: banning ? '封禁' : '解封',
    cancelBtn: '取消',
    onConfirm: async () => {
      try {
        await api.put(`/users/${row.id}/ban`, { isBanned: banning });
        MessagePlugin.success(banning ? '已封禁' : '已解封');
        fetchUsers();
      } catch (error: unknown) {
        MessagePlugin.error(getErrorMessage(error));
      }
      confirmDialog.destroy();
    },
    onClose: () => confirmDialog.destroy(),
  });
}

/** 提升为管理员：二次确认并展示后果（G15-07） */
function grantAdmin(row: { id: string; email: string }) {
  const confirmDialog = DialogPlugin.confirm({
    header: '设为管理员',
    body: `确定要将 "${row.email}" 提升为管理员吗？`
      + '提升后该用户将获得管理员权限，可管理用户、封禁 IP、查看系统配置等，请谨慎操作。',
    theme: 'warning',
    confirmBtn: '确认提升',
    cancelBtn: '取消',
    onConfirm: async () => {
      try {
        await api.put(`/users/${row.id}/role`, { role: 'admin' });
        MessagePlugin.success('已设为管理员');
        fetchUsers();
      } catch (error: unknown) {
        MessagePlugin.error(getErrorMessage(error));
      }
      confirmDialog.destroy();
    },
    onClose: () => confirmDialog.destroy(),
  });
}

/** 降级为普通用户：二次确认（G15-07，恢复 admin→user 降级路径） */
function demoteAdmin(row: { id: string; email: string }) {
  const confirmDialog = DialogPlugin.confirm({
    header: '取消管理员权限',
    body: `确定要取消 "${row.email}" 的管理员权限，降级为普通用户吗？`
      + '降级后该用户将失去管理后台访问权限。',
    theme: 'warning',
    confirmBtn: '确认降级',
    cancelBtn: '取消',
    onConfirm: async () => {
      try {
        await api.put(`/users/${row.id}/role`, { role: 'user' });
        MessagePlugin.success('已降级为普通用户');
        fetchUsers();
      } catch (error: unknown) {
        MessagePlugin.error(getErrorMessage(error));
      }
      confirmDialog.destroy();
    },
    onClose: () => confirmDialog.destroy(),
  });
}

function deleteUser(id: string) {
  const confirmDialog = DialogPlugin.confirm({
    header: '删除用户',
    body: '确定要删除此用户吗？此操作不可恢复。',
    theme: 'danger',
    confirmBtn: '删除',
    cancelBtn: '取消',
    onConfirm: async () => {
      try {
        await api.delete(`/users/${id}`);
        MessagePlugin.success('删除成功');
        fetchUsers();
      } catch (error: unknown) {
        MessagePlugin.error(getErrorMessage(error));
      }
      confirmDialog.destroy();
    },
    onClose: () => confirmDialog.destroy(),
  });
}

/**
 * 创建用户（G15-26）：先前端校验，再对 admin 角色二次确认，最后提交。
 */
async function createUser() {
  // 前端表单校验：空邮箱/空密码/弱密码/非法邮箱直接拦截（G15-26）
  if (!validateCreateForm()) return;

  const submit = async () => {
    try {
      await api.post('/users', createForm.value);
      MessagePlugin.success('创建成功');
      showCreateDialog.value = false;
      createForm.value = { email: '', password: '', role: 'user' };
      fetchUsers();
    } catch (error: unknown) {
      MessagePlugin.error(getErrorMessage(error));
    }
  };

  // 创建管理员：权限授予属高风险操作，二次确认
  if (createForm.value.role === 'admin') {
    const confirmDialog = DialogPlugin.confirm({
      header: '创建管理员',
      body: `将为 "${createForm.value.email}" 创建管理员账户。`
        + '管理员拥有用户管理、IP 封禁、系统配置等高级权限，请确认操作对象无误。',
      theme: 'warning',
      confirmBtn: '确认创建管理员',
      cancelBtn: '取消',
      onConfirm: () => {
        confirmDialog.destroy();
        void submit();
      },
      onClose: () => confirmDialog.destroy(),
    });
    return;
  }
  await submit();
}

onMounted(fetchUsers);
</script>

<style scoped>
@media (max-width: 768px) {
  .mobile-user-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 10px;
  }
}
</style>
