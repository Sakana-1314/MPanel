<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NFormItem,
  NIcon,
  NInput,
  NModal,
  NTabPane,
  NTabs,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui';
import {
  AddOutline,
  CheckmarkCircleOutline,
  CreateOutline,
  KeyOutline,
  MoonOutline,
  RefreshOutline,
  ServerOutline,
  SunnyOutline,
  TrashOutline,
} from '@vicons/ionicons5';
import { probeConnection, type ConnectionProbeResult } from '@/api/client';
import { describeError } from '@/api/errors';
import { useCoreApi } from '@/lib/api';
import {
  activeConnection,
  activeConnectionId,
  addConnection,
  listConnections,
  removeConnection,
  setActiveConnection,
  updateConnection,
} from '@/lib/connection-store';
import { sessionSnapshot } from '@/lib/session';
import { authenticated } from '@/lib/machines';
import { coreKey } from '@/lib/query-keys';
import { formatDate, formatUptime } from '@/lib/format';
import { useTheme } from '@/lib/theme';
import { queryClient } from '@/lib/query-client';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';

const api = useCoreApi();
const dialog = useDialog();
const message = useMessage();
const { isDark, toggle } = useTheme();
const session = sessionSnapshot();

const connections = computed(() => listConnections());
const connection = activeConnection;

const coreInfoQuery = useQuery({
  queryKey: coreKey('system', 'info'),
  queryFn: () => api.value.system.info(),
  enabled: authenticated(),
  staleTime: 60_000,
});

/* ------------------------------- connections ------------------------------- */

const formOpen = ref(false);
const editingId = ref<string | null>(null);
const formName = ref('');
const formUrl = ref('');
const formError = ref<string | null>(null);
const saving = ref(false);
const testResults = reactive<Record<string, ConnectionProbeResult>>({});
const testingId = ref<string | null>(null);

function openAdd(): void {
  editingId.value = null;
  formName.value = '';
  formUrl.value = '';
  formError.value = null;
  formOpen.value = true;
}

function openEdit(id: string): void {
  const item = connections.value.find((entry) => entry.id === id);
  if (item === undefined) return;
  editingId.value = id;
  formName.value = item.name;
  formUrl.value = item.baseUrl;
  formError.value = null;
  formOpen.value = true;
}

async function testRow(id: string): Promise<void> {
  const item = connections.value.find((entry) => entry.id === id);
  if (item === undefined) return;
  testingId.value = id;
  try {
    testResults[id] = await probeConnection({ baseUrl: item.baseUrl });
  } finally {
    testingId.value = null;
  }
}

async function save(): Promise<void> {
  const name = formName.value.trim();
  const url = formUrl.value.trim();
  if (name.length === 0 || url.length === 0) {
    formError.value = '请填写名称与服务器地址。';
    return;
  }
  const probe = await probeConnection({ baseUrl: url });
  if (!probe.ok) {
    formError.value = `地址不可用：${describeError(probe.error).description}`;
    return;
  }
  saving.value = true;
  try {
    if (editingId.value === null) {
      const created = addConnection({ name, baseUrl: url });
      message.success(`已添加服务器 ${created.name}`);
      if (activeConnectionId.value === null) setActiveConnection(created.id);
    } else {
      updateConnection(editingId.value, { name, baseUrl: url });
      if (editingId.value === activeConnectionId.value) {
        queryClient.clear();
        message.info('当前连接地址已更新，页面会自动重新校验会话。');
        window.location.reload();
        return;
      }
      message.success('连接已更新');
    }
    formOpen.value = false;
  } finally {
    saving.value = false;
  }
}

function confirmRemove(id: string): void {
  const item = connections.value.find((entry) => entry.id === id);
  if (item === undefined) return;
  dialog.warning({
    title: '删除服务器',
    content: `确定删除“${item.name}”？只清理浏览器里的连接配置，不影响服务器本身。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      removeConnection(id);
      queryClient.clear();
      message.success('连接已删除');
    },
  });
}

function switchConnection(id: string): void {
  if (id === activeConnectionId.value) return;
  dialog.info({
    title: '切换服务器',
    content: '切换后工作台标签会清空，并重新校验登录会话。是否继续？',
    positiveText: '切换',
    negativeText: '取消',
    onPositiveClick: () => {
      setActiveConnection(id);
    },
  });
}

/* ------------------------------- password ------------------------------- */

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const passwordBusy = ref(false);
const passwordError = ref<string | null>(null);

async function changePassword(): Promise<void> {
  passwordError.value = null;
  if (currentPassword.value.length === 0) {
    passwordError.value = '请输入当前密码。';
    return;
  }
  if (newPassword.value.length < 10) {
    passwordError.value = '新密码至少 10 个字符。';
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    passwordError.value = '两次输入的新密码不一致。';
    return;
  }
  passwordBusy.value = true;
  try {
    await api.value.auth.changePassword({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    });
    message.success('密码已修改；其它会话已失效，当前会话保持登录。');
    currentPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
  } catch (error) {
    passwordError.value = describeError(error).description + ' ' + describeError(error).hint;
  } finally {
    passwordBusy.value = false;
  }
}

const coreInfo = computed(() => coreInfoQuery.data.value);
const isTokenAuth = computed(() => session.me?.authType === 'token');
const authLabel = computed(() => (isTokenAuth.value ? '访问令牌' : '账号密码'));
</script>

<template>
  <div class="page">
    <PageHeader
      title="设置"
    >
      <template #actions>
        <n-button size="small" secondary @click="toggle">
          <template #icon><n-icon :component="isDark ? SunnyOutline : MoonOutline" /></template>
          {{ isDark ? '浅色主题' : '深色主题' }}
        </n-button>
      </template>
    </PageHeader>

    <n-tabs type="line" animated>
      <n-tab-pane name="connections" tab="服务器">
        <n-card size="small">
          <div class="toolbar" style="margin-bottom: 10px">
            <span class="small muted">
              当前账号：{{ session.user?.displayName ?? session.user?.username ?? '—' }}
              · {{ authLabel }}
            </span>
            <div class="spacer" />
            <n-button size="small" type="primary" @click="openAdd">
              <template #icon><n-icon :component="AddOutline" /></template>
              新增服务器
            </n-button>
          </div>

          <div class="conn-list">
            <div v-for="item in connections" :key="item.id" class="conn-item">
              <div class="conn-main">
                <div class="conn-title">
                  <strong>{{ item.name }}</strong>
                  <n-tag v-if="item.id === activeConnectionId" size="tiny" type="success" round :bordered="false">
                    当前
                  </n-tag>
                  <n-tag
                    v-if="testResults[item.id]"
                    size="tiny"
                    :type="testResults[item.id]!.ok ? 'success' : 'error'"
                    round
                    :bordered="false"
                  >
                    {{ testResults[item.id]!.ok ? `可达 · ${testResults[item.id]!.latencyMs} ms` : '不可达' }}
                  </n-tag>
                </div>
                <div class="mono tiny muted truncate">{{ item.baseUrl }}</div>
                <div v-if="item.username" class="tiny muted">登录用户：{{ item.username }}</div>
              </div>
              <div class="conn-actions">
                <n-button size="tiny" quaternary :loading="testingId === item.id" @click="testRow(item.id)">
                  <template #icon><n-icon :component="RefreshOutline" /></template>
                  测试
                </n-button>
                <n-button size="tiny" quaternary :disabled="item.id === activeConnectionId" @click="switchConnection(item.id)">
                  <template #icon><n-icon :component="CheckmarkCircleOutline" /></template>
                  切换
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
        </n-card>
      </n-tab-pane>

      <n-tab-pane name="password" tab="修改密码">
        <n-card size="small" style="max-width: 560px">
          <n-alert v-if="isTokenAuth" type="warning" :bordered="false" title="当前使用访问令牌登录">
            访问令牌没有用户密码；请使用用户名/密码登录后再修改密码。
          </n-alert>
          <div v-else class="form">
            <n-form-item label="当前密码">
              <n-input v-model:value="currentPassword" type="password" show-password-on="click" />
            </n-form-item>
            <n-form-item label="新密码（至少 10 个字符）">
              <n-input v-model:value="newPassword" type="password" show-password-on="click" />
            </n-form-item>
            <n-form-item label="确认新密码">
              <n-input v-model:value="confirmPassword" type="password" show-password-on="click" />
            </n-form-item>
            <n-alert v-if="passwordError" type="error" :bordered="true">{{ passwordError }}</n-alert>
            <div class="toolbar">
              <n-button type="primary" :loading="passwordBusy" @click="changePassword">
                <template #icon><n-icon :component="KeyOutline" /></template>
                修改密码
              </n-button>
            </div>
          </div>
        </n-card>
      </n-tab-pane>

      <n-tab-pane name="about" tab="关于">
        <div class="about-grid">
          <n-card size="small" title="服务器信息">
            <error-state
              v-if="coreInfoQuery.isError.value"
              :error="coreInfoQuery.error.value"
              @retry="coreInfoQuery.refetch()"
            />
            <n-descriptions v-else-if="coreInfo" label-placement="left" bordered size="small" :column="1">
              <n-descriptions-item label="版本">{{ coreInfo.version }}</n-descriptions-item>
              <n-descriptions-item label="主机名">{{ coreInfo.hostname }}</n-descriptions-item>
              <n-descriptions-item label="平台">{{ coreInfo.platform }}/{{ coreInfo.arch }}</n-descriptions-item>
              <n-descriptions-item label="启动时间">{{ formatDate(coreInfo.startedAt) }}</n-descriptions-item>
              <n-descriptions-item label="运行时长">{{ formatUptime(coreInfo.uptimeSec) }}</n-descriptions-item>
              <n-descriptions-item label="地址">{{ connection?.baseUrl ?? '—' }}</n-descriptions-item>
            </n-descriptions>
            <n-alert v-else type="info" :bordered="false">正在读取服务器信息…</n-alert>
          </n-card>

          <n-card size="small" title="版本与文档">
            <n-descriptions label-placement="left" bordered size="small" :column="1">
              <n-descriptions-item label="面板版本">0.3.0</n-descriptions-item>
              <n-descriptions-item label="文档">
                <a href="https://sakana-1314.github.io/MPanel/docs/" target="_blank" rel="noopener">
                  sakana-1314.github.io/MPanel/docs
                </a>
              </n-descriptions-item>
            </n-descriptions>
          </n-card>
        </div>
      </n-tab-pane>
    </n-tabs>

    <n-modal
      v-model:show="formOpen"
      preset="card"
      :title="editingId === null ? '新增服务器' : '编辑服务器'"
      style="width: 620px; max-width: calc(100vw - 24px)"
    >
      <div class="form">
        <n-form-item label="名称">
          <n-input v-model:value="formName" placeholder="例如：生产服务器" />
        </n-form-item>
        <n-form-item label="服务器地址">
          <n-input v-model:value="formUrl" placeholder="https://panel.example.com 或 http://127.0.0.1:10086" />
        </n-form-item>
        <n-alert v-if="formError" type="error" :bordered="true">{{ formError }}</n-alert>
      </div>
      <template #footer>
        <div class="toolbar" style="justify-content: flex-end">
          <n-button quaternary @click="formOpen = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="save">保存</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.conn-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
.conn-main {
  min-width: 0;
}
.conn-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.conn-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 2px;
}
.about-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}
@media (max-width: 900px) {
  .about-grid {
    grid-template-columns: 1fr;
  }
  .conn-item {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
