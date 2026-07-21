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
            v-if="row.role !== 'super_admin'"
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
            @click="grantAdmin(row.id)"
          >
            设为管理员
          </t-button>
          <t-button
            v-if="row.role !== 'super_admin'"
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
              v-if="user.role !== 'super_admin'"
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
              @click="grantAdmin(user.id)"
            >
              设为管理员
            </t-button>
            <t-button
              v-if="user.role !== 'super_admin'"
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

    <t-dialog v-model:visible="showCreateDialog" header="创建用户" @confirm="createUser">
      <t-form :data="createForm" layout="vertical">
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
import { api } from '../../stores/auth';
import { getErrorMessage } from '../../utils/error';

const users = ref<{ id: string; email: string; role: string; isBanned: boolean; emailVerified: boolean; createdAt: string; lastLoginAt?: string }[]>([]);
const total = ref(0);
const page = ref(1);
const searchEmail = ref('');
const showCreateDialog = ref(false);
const createForm = ref({ email: '', password: '', role: 'user' });

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

async function toggleBan(row: { id: string; isBanned: boolean }) {
  try {
    await api.put(`/users/${row.id}/ban`, { isBanned: !row.isBanned });
    MessagePlugin.success(row.isBanned ? '已解封' : '已封禁');
    fetchUsers();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function grantAdmin(id: string) {
  try {
    await api.put(`/users/${id}/role`, { role: 'admin' });
    MessagePlugin.success('已设为管理员');
    fetchUsers();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
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

async function createUser() {
  try {
    await api.post('/users', createForm.value);
    MessagePlugin.success('创建成功');
    showCreateDialog.value = false;
    createForm.value = { email: '', password: '', role: 'user' };
    fetchUsers();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
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
