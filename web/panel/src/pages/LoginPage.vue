<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NEmpty,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  NModal,
  NSpin,
  NTag,
  NTooltip,
  useDialog,
  useMessage,
  NSelect,
} from 'naive-ui';
import {
  AddOutline,
  CheckmarkCircleOutline,
  CreateOutline,
  KeyOutline,
  LockClosedOutline,
  MoonOutline,
  PersonOutline,
  RefreshOutline,
  SettingsOutline,
  SunnyOutline,
  TrashOutline,
} from '@vicons/ionicons5';
import type { AppError } from '@/api/errors';
import { AppError as PanelError, describeError } from '@/api/errors';
import { probeConnection, type ConnectionProbeResult } from '@/api/client';
import {
  activeConnection,
  activeConnectionId,
  addConnection,
  listConnections,
  removeConnection,
  setActiveConnection,
  updateConnection,
} from '@/lib/connection-store';
import { ensureSession, login, resetSession, sessionSnapshot } from '@/lib/session';
import { queryClient } from '@/lib/query-client';
import { useTheme } from '@/lib/theme';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const dialog = useDialog();
const { isDark, toggle } = useTheme();

const session = sessionSnapshot();
const connections = computed(() => listConnections());
const connection = activeConnection;

const username = ref('');
const password = ref('');
const submitting = ref(false);
const loginError = ref<AppError | null>(null);

const managerOpen = ref(false);
const formOpen = ref(false);
const editingId = ref<string | null>(null);
const formName = ref('');
const formUrl = ref('');
const formSaving = ref(false);
const formError = ref<string | null>(null);
const testing = ref(false);
const testResult = ref<ConnectionProbeResult | null>(null);

watch(
  () => connection.value?.id,
  () => {
    username.value = connection.value?.username ?? '';
    password.value = '';
    loginError.value = null;
  },
  { immediate: true },
);

const redirectTarget = computed(() => {
  const redirect = route.query.redirect;
  if (typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('/login')) {
    return redirect;
  }
  return '/';
});

const errorInfo = computed(() => (loginError.value === null ? null : describeError(loginError.value)));

onMounted(() => {
  if (activeConnectionId.value !== null) void ensureSession();
});

watch(activeConnectionId, (id) => {
  if (id !== null) void ensureSession(true);
});

async function submit(): Promise<void> {
  if (connection.value === undefined) return;
  if (username.value.trim().length === 0 || password.value.length === 0) {
    loginError.value = new PanelError('BAD_REQUEST', '请填写用户名与密码', 0, {
      hint: 'core 登录需要账号密码；没有账号请查看 core 的初始化配置。',
    });
    return;
  }
  submitting.value = true;
  loginError.value = null;
  try {
    await login(username.value, password.value);
    if (connection.value !== undefined) {
      updateConnection(connection.value.id, { username: username.value.trim() });
    }
    queryClient.clear();
    await router.replace(redirectTarget.value);
  } catch (error) {
    loginError.value = error as AppError;
  } finally {
    submitting.value = false;
  }
}

function openAdd(): void {
  editingId.value = null;
  formName.value = '';
  formUrl.value = '';
  formError.value = null;
  testResult.value = null;
  formOpen.value = true;
}

function openEdit(id: string): void {
  const item = connections.value.find((entry) => entry.id === id);
  if (item === undefined) return;
  editingId.value = id;
  formName.value = item.name;
  formUrl.value = item.baseUrl;
  formError.value = null;
  testResult.value = null;
  formOpen.value = true;
}

async function testForm(): Promise<void> {
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await probeConnection({ baseUrl: formUrl.value });
  } finally {
    testing.value = false;
  }
}

async function saveForm(): Promise<void> {
  const name = formName.value.trim();
  const url = formUrl.value.trim();
  if (name.length === 0) {
    formError.value = '请填写连接名称。';
    return;
  }
  if (url.length === 0) {
    formError.value = '请填写 core 地址，例如 https://panel.example.com。';
    return;
  }
  const probe = await probeConnection({ baseUrl: url });
  if (!probe.ok) {
    formError.value = `地址不可用：${describeError(probe.error).description} ${describeError(probe.error).hint}`;
    return;
  }
  formSaving.value = true;
  formError.value = null;
  try {
    if (editingId.value === null) {
      const created = addConnection({ name, baseUrl: url });
      setActiveConnection(created.id);
      message.success(`已添加 core 连接 ${created.name}`);
    } else {
      updateConnection(editingId.value, { name, baseUrl: url });
      if (editingId.value === activeConnectionId.value) {
        resetSession();
        queryClient.clear();
      }
      message.success('连接已更新');
    }
    formOpen.value = false;
  } finally {
    formSaving.value = false;
  }
}

function confirmRemove(id: string): void {
  const item = connections.value.find((entry) => entry.id === id);
  if (item === undefined) return;
  dialog.warning({
    title: '删除 core 连接',
    content: `确定删除“${item.name}”（${item.baseUrl}）？这不会影响 core 服务本身，只清理浏览器里的连接配置。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      removeConnection(id);
      queryClient.clear();
      message.success('连接已删除');
    },
  });
}

function selectConnection(id: string): void {
  setActiveConnection(id);
  void ensureSession(true);
}
</script>

<template>
  <div class="login-page">
    <button type="button" class="theme-toggle" @click="toggle">
      <n-icon :component="isDark ? SunnyOutline : MoonOutline" />
      {{ isDark ? '浅色' : '深色' }}
    </button>

    <div class="login-wrap">
      <div class="brand">
        <span class="logo">M</span>
        <div>
          <h1>MPanel</h1>
          <p class="small muted">core 控制面 · 多机工作台</p>
        </div>
      </div>

      <n-card :bordered="true" class="login-card">
        <template v-if="connections.length === 0">
          <n-empty description="连接 core">
            <template #extra>
              <n-button type="primary" @click="openAdd">
                <template #icon><n-icon :component="AddOutline" /></template>
                新增 core 连接
              </n-button>
            </template>
          </n-empty>
        </template>

        <template v-else>
          <n-form :show-label="true" label-placement="top">
            <n-form-item label="core 连接">
              <div class="connection-row">
                <n-select
                  :value="activeConnectionId"
                  :options="connections.map((item) => ({ label: item.name, value: item.id }))"
                  @update:value="selectConnection"
                />
                <n-tooltip>
                  <template #trigger>
                    <n-button secondary circle @click="managerOpen = true">
                      <template #icon><n-icon :component="SettingsOutline" /></template>
                    </n-button>
                  </template>
                  连接管理
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button secondary circle @click="openAdd">
                      <template #icon><n-icon :component="AddOutline" /></template>
                    </n-button>
                  </template>
                  新增连接
                </n-tooltip>
              </div>
            </n-form-item>

            <div v-if="connection" class="conn-meta">
              <n-tag size="small" type="info" round :bordered="false">core</n-tag>
              <span class="mono small muted truncate">{{ connection.baseUrl }}</span>
            </div>

            <template v-if="session.status === 'checking'">
              <div class="center"><n-spin size="small" /> <span class="small muted">正在验证 core 会话…</span></div>
            </template>

            <template v-else-if="session.status === 'error'">
              <n-alert type="error" title="无法连接 core" :bordered="true" style="margin-top: 12px">
                <div>{{ session.error?.message ?? '未知错误' }}</div>
                <div style="margin-top: 8px">
                  <n-button size="small" secondary @click="ensureSession(true)">
                    <template #icon><n-icon :component="RefreshOutline" /></template>
                    重试
                  </n-button>
                </div>
              </n-alert>
            </template>

            <template v-else>
              <n-form-item label="用户名">
                <n-input
                  v-model:value="username"
                  placeholder="admin"
                  autocomplete="username"
                  :input-props="{ autocomplete: 'username' }"
                >
                  <template #prefix><n-icon :component="PersonOutline" /></template>
                </n-input>
              </n-form-item>
              <n-form-item label="密码">
                <n-input
                  v-model:value="password"
                  type="password"
                  show-password-on="click"
                  placeholder="core 登录密码"
                  :input-props="{ autocomplete: 'current-password' }"
                  @keydown.enter="submit"
                >
                  <template #prefix><n-icon :component="LockClosedOutline" /></template>
                </n-input>
              </n-form-item>

              <n-button
                type="primary"
                block
                :loading="submitting"
                :disabled="username.trim().length === 0 || password.length === 0"
                @click="submit"
              >
                登录
              </n-button>
            </template>

            <n-alert
              v-if="errorInfo"
              type="error"
              :title="errorInfo.title"
              :bordered="true"
              style="margin-top: 12px"
            >
              <div>{{ errorInfo.description }}</div>
              <div class="small muted">{{ errorInfo.hint }}</div>
            </n-alert>
          </n-form>
        </template>
      </n-card>


    </div>

    <!-- 连接管理 -->
    <n-modal
      v-model:show="managerOpen"
      preset="card"
      title="core 连接"
      style="width: 760px; max-width: calc(100vw - 24px)"
    >
      <div class="manager-toolbar">
        <span class="small muted">共 {{ connections.length }} 个连接</span>
        <n-button size="small" type="primary" @click="openAdd">
          <template #icon><n-icon :component="AddOutline" /></template>
          新增 core
        </n-button>
      </div>
      <n-empty v-if="connections.length === 0" description="暂无连接" />
      <div v-else class="conn-list">
        <div v-for="item in connections" :key="item.id" class="conn-item">
          <div class="conn-item-main">
            <div class="conn-item-title">
              <strong>{{ item.name }}</strong>
              <n-tag v-if="item.id === activeConnectionId" size="tiny" type="success" round :bordered="false">
                当前
              </n-tag>
            </div>
            <div class="mono tiny muted truncate">{{ item.baseUrl }}</div>
          </div>
          <div class="conn-item-actions">
            <n-button size="tiny" quaternary :disabled="item.id === activeConnectionId" @click="selectConnection(item.id)">
              <template #icon><n-icon :component="CheckmarkCircleOutline" /></template>
              设为当前
            </n-button>
            <n-button size="tiny" quaternary @click="openEdit(item.id)">
              <template #icon><n-icon :component="CreateOutline" /></template>
              编辑
            </n-button>
            <n-button size="tiny" quaternary type="error" @click="confirmRemove(item.id)">
              <template #icon><n-icon :component="TrashOutline" /></template>
            </n-button>
          </div>
        </div>
      </div>
    </n-modal>

    <!-- 新增/编辑连接 -->
    <n-modal
      v-model:show="formOpen"
      preset="card"
      :title="editingId === null ? '新增 core 连接' : '编辑 core 连接'"
      style="width: 620px; max-width: calc(100vw - 24px)"
    >
      <div class="stack">
        <n-form-item label="名称">
          <n-input v-model:value="formName" placeholder="例如：生产 core / 本地 core" />
        </n-form-item>
        <n-form-item label="core 地址">
          <n-input
            v-model:value="formUrl"
            placeholder="https://panel.example.com 或 http://127.0.0.1:10086"
          >
            <template #prefix><n-icon :component="KeyOutline" /></template>
          </n-input>
        </n-form-item>

        <div class="toolbar">
          <n-button size="small" secondary :loading="testing" @click="testForm">
            <template #icon><n-icon :component="RefreshOutline" /></template>
            测试连通性
          </n-button>
          <span v-if="testResult" class="small">
            <n-tag v-if="testResult.ok" size="small" type="success" :bordered="false" round>
              core {{ testResult.info?.version }} · {{ testResult.latencyMs }} ms
            </n-tag>
            <n-tag v-else size="small" type="error" :bordered="false" round>
              {{ describeError(testResult.error).description }}
            </n-tag>
          </span>
        </div>

        <n-alert v-if="formError" type="error" :bordered="true" title="无法保存">
          {{ formError }}
        </n-alert>
      </div>

      <template #footer>
        <div class="toolbar" style="justify-content: flex-end">
          <n-button quaternary @click="formOpen = false">取消</n-button>
          <n-button type="primary" :loading="formSaving" @click="saveForm">保存</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px 16px;
  background:
    radial-gradient(900px 500px at 15% 0%, color-mix(in srgb, var(--mpanel-accent) 18%, transparent), transparent 60%),
    var(--mpanel-bg);
}
.theme-toggle {
  position: fixed;
  top: 16px;
  right: 16px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--mpanel-border);
  border-radius: 8px;
  background: var(--mpanel-surface);
  color: var(--mpanel-muted);
  cursor: pointer;
  font-size: 12px;
}
.login-wrap {
  width: 100%;
  max-width: 440px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.logo {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: linear-gradient(135deg, #4f7cff, #7a5cff);
  color: #fff;
  font-weight: 800;
  font-size: 20px;
}
.brand h1 {
  margin: 0;
  font-size: 20px;
  letter-spacing: -0.01em;
}
.brand p {
  margin: 2px 0 0;
}
.login-card {
  border-radius: 14px;
}
.connection-row {
  display: flex;
  gap: 6px;
  width: 100%;
}
.connection-row :deep(.n-select) {
  flex: 1;
}
.conn-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: -8px 0 12px;
}
.center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px 0;
}
.stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 14px;
  text-align: center;
}
.manager-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.conn-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 50vh;
  overflow: auto;
}
.conn-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--mpanel-border);
  border-radius: 10px;
  background: var(--mpanel-surface-soft);
}
.conn-item-main {
  min-width: 0;
}
.conn-item-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.conn-item-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
</style>
