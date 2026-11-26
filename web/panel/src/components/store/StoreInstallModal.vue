<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCollapse,
  NCollapseItem,
  NFormItem,
  NIcon,
  NInput,
  NModal,
  NSpin,
  useMessage,
} from 'naive-ui';
import {
  AlertCircleOutline,
  CheckmarkCircleOutline,
  CloseCircleOutline,
  CloudDownloadOutline,
  EllipseOutline,
  OpenOutline,
} from '@vicons/ionicons5';
import type { DatabaseProfile } from '@/api/types';
import { describeError } from '@/api/errors';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import {
  defaultStoreValues,
  fetchStoreApp,
  fetchStoreIndex,
  findStoreApp,
  renderComposeTemplate,
  renderComposeVolumes,
  validateStoreValues,
  type StoreAppBundle,
  type StoreAppManifest,
} from '@/lib/store';

const props = withDefaults(
  defineProps<{
    show: boolean;
    machineId: string;
    appId: string;
    /** 覆盖清单里的标题，用于「安装 Caddy」等场景。 */
    title?: string;
  }>(),
  { title: undefined },
);

const emit = defineEmits<{
  'update:show': [value: boolean];
  installed: [
    {
      manifest: StoreAppManifest;
      createdProfile: DatabaseProfile | null;
      startedExisting: boolean;
    },
  ];
}>();

const api = useMachineApi(() => props.machineId);
const queryClient = useQueryClient();
const message = useMessage();

type StepStatus = 'pending' | 'running' | 'done' | 'warning' | 'error';

interface InstallStep {
  key: string;
  label: string;
  status: StepStatus;
  detail?: string;
}

const loading = ref(false);
const loadError = ref<string | null>(null);
const bundle = ref<StoreAppBundle | null>(null);
const values = reactive<Record<string, string>>({});
const steps = ref<InstallStep[]>([]);
const phase = ref<'idle' | 'deploying' | 'done' | 'error'>('idle');
const deployError = ref<unknown>(null);
const createdProfile = ref<DatabaseProfile | null>(null);
const existingStack = ref(false);
const stackCreated = ref(false);

const manifest = computed(() => bundle.value?.manifest ?? null);
const visibleVariables = computed(() =>
  (manifest.value?.variables ?? []).filter((variable) => !variable.hidden),
);
const renderedCompose = computed(() => {
  if (bundle.value === null) return '';
  try {
    return renderComposeTemplate(bundle.value.compose, values);
  } catch {
    return '';
  }
});
const installTitle = computed(
  () => props.title ?? (manifest.value === null ? '一键安装' : `一键安装 ${manifest.value.name}`),
);

function resetState(): void {
  steps.value = [];
  phase.value = 'idle';
  deployError.value = null;
  createdProfile.value = null;
  existingStack.value = false;
  stackCreated.value = false;
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  resetState();
  try {
    const index = await fetchStoreIndex();
    const summary = findStoreApp(index, props.appId);
    const data = await fetchStoreApp(summary, index.baseUrl);
    bundle.value = data;

    let home: string | undefined;
    try {
      const info = await api.value.system.info();
      home = info.paths?.home;
    } catch {
      // 路径只是默认值，取不到也不阻塞安装。
    }
    for (const key of Object.keys(values)) delete values[key];
    Object.assign(values, defaultStoreValues(data.manifest, { home }));

    try {
      await api.value.stacks.get(data.manifest.stack);
      existingStack.value = true;
    } catch {
      existingStack.value = false;
    }
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.show, props.appId] as const,
  ([show]) => {
    if (show) void load();
  },
  { immediate: true },
);

function close(): void {
  if (phase.value === 'deploying') return;
  emit('update:show', false);
}

function addStep(key: string, label: string): void {
  steps.value.push({ key, label, status: 'pending' });
}

function setStep(key: string, status: StepStatus, detail?: string): void {
  const step = steps.value.find((entry) => entry.key === key);
  if (step === undefined) {
    steps.value.push({ key, label: key, status, detail });
    return;
  }
  step.status = status;
  if (detail !== undefined) step.detail = detail;
}

async function runStep<T>(key: string, task: () => Promise<T>): Promise<T> {
  setStep(key, 'running');
  try {
    const result = await task();
    setStep(key, 'done');
    return result;
  } catch (error) {
    const described = describeError(error);
    setStep(key, 'error', described.description);
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStack(stack: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const detail = await api.value.stacks.get(stack);
      if (detail.status === 'running' || detail.runningCount > 0) {
        setStep('ready', 'done', detail.status === 'running' ? '全部容器已运行' : '容器已启动');
        return;
      }
      setStep('ready', 'running', `等待容器运行（${attempt + 1}/30）`);
    } catch {
      setStep('ready', 'running', `等待编排出现（${attempt + 1}/30）`);
    }
    await sleep(3_000);
  }
  throw new Error('等待容器启动超时；请到「编排」页查看日志。');
}

async function waitForCapability(capability: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const info = await api.value.system.info(true);
      const status = (
        info.capabilities as unknown as Record<
          string,
          { available?: boolean; reason?: string } | undefined
        >
      )[capability];
      if (status?.available === true) {
        setStep('ready', 'done', status.reason ?? '能力已就绪');
        return;
      }
      setStep('ready', 'running', status?.reason ?? `等待 ${capability} 能力就绪（${attempt + 1}/30）`);
    } catch {
      setStep('ready', 'running', `等待能力探测（${attempt + 1}/30）`);
    }
    await sleep(3_000);
  }
  throw new Error(`等待 ${capability} 能力就绪超时；请到「编排」页查看容器日志。`);
}

async function waitForProfile(profileId: string): Promise<void> {
  let lastMessage = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const result = await api.value.databases.test(profileId);
      if (result.ok) {
        setStep('verify', 'done', `连接正常（${result.latencyMs} ms）`);
        return;
      }
      lastMessage = result.message ?? '目标暂不可达';
      setStep('verify', 'running', `等待数据库就绪（${attempt + 1}/20）`);
    } catch (error) {
      lastMessage = describeError(error).description;
      setStep('verify', 'running', `等待数据库就绪（${attempt + 1}/20）`);
    }
    await sleep(3_000);
  }
  setStep('verify', 'warning', lastMessage || '档案已创建，但连接测试尚未通过');
}

function buildProfileInput(
  app: StoreAppManifest,
): import('@/api/types').DatabaseProfileCreateInput | null {
  const mapping = app.profile;
  if (mapping === undefined) return null;
  const portRaw = mapping.portVariable === undefined ? '' : values[mapping.portVariable] ?? '';
  const port = Number(portRaw);
  const input: import('@/api/types').DatabaseProfileCreateInput = {
    name: mapping.name,
    kind: mapping.kind,
    host: mapping.host,
    ...(Number.isInteger(port) && port > 0 ? { port } : {}),
    tls: false,
  };
  if (mapping.usernameVariable !== undefined) {
    const username = values[mapping.usernameVariable] ?? '';
    if (username.length > 0) input.username = username;
  }
  if (mapping.passwordVariable !== undefined) {
    const password = values[mapping.passwordVariable] ?? '';
    if (password.length > 0) input.password = password;
  }
  if (mapping.kind === 'postgres' && mapping.databaseVariable !== undefined) {
    const database = values[mapping.databaseVariable] ?? '';
    if (database.length > 0) input.database = database;
  }
  if (mapping.kind === 'redis') input.redisDb = mapping.redisDb ?? 0;
  return input;
}

async function deploy(): Promise<void> {
  const app = manifest.value;
  if (app === null || bundle.value === null || phase.value === 'deploying') return;
  const invalid = validateStoreValues(app, values);
  if (invalid !== null) {
    deployError.value = new Error(invalid);
    return;
  }
  deployError.value = null;
  createdProfile.value = null;
  phase.value = 'deploying';
  steps.value = [];
  const startedExisting = existingStack.value && !stackCreated.value;

  try {
    addStep('template', '读取商店模板');
    setStep('template', 'done', bundle.value.manifestUrl);

    if (app.bootstrap === 'sites') {
      addStep('prepare', '准备 Caddy 目录与挂载');
      const prepared = await runStep('prepare', () => api.value.sites.bootstrap());
      const volumes = renderComposeVolumes(prepared.mounts);
      if (volumes.trim().length === 0) throw new Error('安装准备没有返回任何挂载');
      values.CADDY_VOLUMES = volumes;
      setStep(
        'prepare',
        'done',
        `${prepared.mounts.length} 个挂载 · ${prepared.configDir}`,
      );
    }

    // 先在本地渲染一次，变量缺失会在创建编排前报错。
    const compose = renderComposeTemplate(bundle.value.compose, values);

    if (startedExisting) {
      addStep('create', '复用已有编排');
      setStep('create', 'done', `未改写 ${app.stack} 的 compose 与密码`);
    } else if (stackCreated.value) {
      addStep('create', '更新编排');
      await runStep('create', () =>
        api.value.stacks.update(app.stack, { composeYaml: compose }),
      );
    } else {
      addStep('create', '创建编排');
      await runStep('create', () =>
        api.value.stacks.create({ name: app.stack, composeYaml: compose }),
      );
      // 编排已落盘；后续重试改为 update，保留当前表单值（端口、密码等）。
      existingStack.value = true;
      stackCreated.value = true;
    }

    addStep('up', '启动容器');
    await runStep('up', () => api.value.stacks.action(app.stack, 'up', {}));

    addStep('ready', '等待容器就绪');
    if (app.capability !== undefined) {
      await waitForCapability(app.capability);
    } else {
      await waitForStack(app.stack);
    }

    if (app.profile !== undefined) {
      if (startedExisting) {
        addStep('profile', '创建数据库档案');
        setStep('profile', 'warning', '编排已存在，无法还原原密码；请手动新建档案');
      } else {
        addStep('profile', '创建数据库档案');
        const input = buildProfileInput(app);
        if (input === null) throw new Error('应用清单缺少数据库档案映射');
        const existingProfiles = await api.value.databases.list({ limit: 200 });
        const sameName = existingProfiles.items.find((profile) => profile.name === input.name);
        let profile: DatabaseProfile;
        if (sameName !== undefined) {
          profile = sameName;
          setStep('profile', 'warning', `同名档案 ${sameName.name} 已存在，直接复用`);
        } else {
          profile = await runStep('profile', () => api.value.databases.create(input));
        }
        createdProfile.value = profile;
        addStep('verify', '测试数据库连接');
        await waitForProfile(profile.id);
      }
    }

    phase.value = 'done';
    message.success(`${app.name} 安装完成`);
    emit('installed', {
      manifest: app,
      createdProfile: createdProfile.value,
      startedExisting,
    });
    void invalidate();
  } catch (error) {
    phase.value = 'error';
    deployError.value = error;
    const current = steps.value.find((step) => step.status === 'running');
    if (current !== undefined) setStep(current.key, 'error', describeError(error).description);
    void invalidate();
  }
}

async function invalidate(): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: machineKey(props.machineId, 'sites') }),
    queryClient.invalidateQueries({ queryKey: machineKey(props.machineId, 'databases') }),
    queryClient.invalidateQueries({ queryKey: machineKey(props.machineId, 'system') }),
    queryClient.invalidateQueries({ queryKey: machineKey(props.machineId, 'stacks') }),
    queryClient.invalidateQueries({ queryKey: machineKey(props.machineId, 'containers') }),
  ]);
}

const errorInfo = computed(() => (deployError.value === null ? null : describeError(deployError.value)));
const errorOutput = computed(() => {
  const details = (deployError.value as { details?: unknown } | null)?.details;
  if (typeof details !== 'object' || details === null) return '';
  const output = (details as { output?: unknown }).output;
  return typeof output === 'string' ? output : '';
});

function stepIcon(status: StepStatus) {
  if (status === 'done') return CheckmarkCircleOutline;
  if (status === 'error') return CloseCircleOutline;
  if (status === 'warning') return AlertCircleOutline;
  if (status === 'running') return CloudDownloadOutline;
  return EllipseOutline;
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="installTitle"
    style="width: 680px; max-width: calc(100vw - 24px)"
    :mask-closable="phase !== 'deploying'"
    :closable="phase !== 'deploying'"
    @update:show="close"
  >
    <n-spin :show="loading">
      <div v-if="loadError" class="install-error">
        <n-alert type="error" :bordered="true" title="无法读取商店模板">
          {{ loadError }}
          <div class="tiny muted" style="margin-top: 6px">
            可在 config.json 设置 storeUrl 指向可访问的镜像（GitHub raw / jsDelivr / 同源 /store）。
          </div>
        </n-alert>
        <n-button size="small" secondary @click="load">重试</n-button>
      </div>

      <div v-else-if="manifest" class="install-body">
        <div class="app-head">
          <div>
            <div class="app-title">
              <strong>{{ manifest.name }}</strong>
              <span v-if="manifest.version" class="tiny muted mono">{{ manifest.version }}</span>
            </div>
            <div class="small muted">{{ manifest.tagline ?? manifest.description }}</div>
          </div>
          <div class="app-links">
            <a
              v-for="link in manifest.links ?? []"
              :key="link.url"
              :href="link.url"
              target="_blank"
              rel="noreferrer noopener"
              class="inline-link"
            >
              {{ link.label }}
              <n-icon :component="OpenOutline" size="12" />
            </a>
          </div>
        </div>

        <n-alert v-if="existingStack && !stackCreated" type="info" :bordered="false">
          已存在编排 <code>{{ manifest.stack }}</code>。本次只启动现有编排，不会覆盖
          compose 或数据库密码。
        </n-alert>

        <div v-if="phase === 'idle' || phase === 'error'" class="form">
          <n-form-item
            v-for="variable in visibleVariables"
            :key="variable.key"
            :label="variable.label ?? variable.key"
          >
            <n-input
              v-model:value="values[variable.key]"
              :type="variable.secret ? 'password' : 'text'"
              :show-password-on="variable.secret ? 'click' : undefined"
              :placeholder="variable.default || variable.key"
              class="mono"
            />
            <div v-if="variable.description" class="tiny muted field-hint">
              {{ variable.description }}
            </div>
          </n-form-item>

          <n-collapse>
            <n-collapse-item title="查看将写入的 compose" name="compose">
              <pre class="code-block compose-preview">{{ renderedCompose || '变量待填写' }}</pre>
            </n-collapse-item>
          </n-collapse>
        </div>

        <div v-if="steps.length > 0" class="steps">
          <div v-for="step in steps" :key="step.key" class="step" :class="`step-${step.status}`">
            <n-icon :component="stepIcon(step.status)" size="16" />
            <div class="step-main">
              <span>{{ step.label }}</span>
              <span v-if="step.detail" class="tiny muted step-detail">{{ step.detail }}</span>
            </div>
          </div>
        </div>

        <n-alert v-if="errorInfo" type="error" :bordered="true" title="安装失败">
          <div>{{ errorInfo.description }}</div>
          <div v-if="errorInfo.hint" class="small muted">{{ errorInfo.hint }}</div>
          <pre v-if="errorOutput" class="code-block" style="margin-top: 8px; max-height: 180px">{{ errorOutput }}</pre>
        </n-alert>

        <n-alert v-if="phase === 'done'" type="success" :bordered="false" title="安装完成">
          <template v-if="createdProfile">
            已创建数据库档案 <strong>{{ createdProfile.name }}</strong>，可在列表中测试、查看统计与备份。
          </template>
          <template v-else>
            {{ manifest.bootstrap === 'sites' ? '站点功能已可用。' : '编排已启动。' }}
          </template>
        </n-alert>

        <div class="template-source tiny muted">
          模板来源
          <a :href="bundle?.manifestUrl" target="_blank" rel="noreferrer noopener">
            {{ bundle?.manifestUrl }}
          </a>
        </div>
      </div>
    </n-spin>

    <template #footer>
      <div class="toolbar" style="justify-content: flex-end">
        <n-button quaternary :disabled="phase === 'deploying'" @click="close">
          {{ phase === 'done' ? '完成' : '取消' }}
        </n-button>
        <n-button
          v-if="phase !== 'done'"
          type="primary"
          :loading="phase === 'deploying'"
          :disabled="loading || loadError !== null || manifest === null"
          @click="deploy"
        >
          {{ phase === 'error' ? '重试安装' : existingStack ? '启动编排' : '开始安装' }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.install-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.app-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.app-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}
.app-links {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-end;
}
.inline-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  white-space: nowrap;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.field-hint {
  margin-top: 4px;
  width: 100%;
}
.compose-preview {
  max-height: 240px;
  margin: 4px 0 0;
}
.steps {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--mpanel-surface-soft);
}
.step {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
}
.step-pending {
  color: var(--mpanel-muted);
}
.step-done {
  color: var(--mpanel-text);
}
.step-warning {
  color: var(--mpanel-attention);
  font-weight: 600;
}
.step-error {
  color: var(--mpanel-danger);
  font-weight: 600;
}
.step-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.step-detail {
  overflow-wrap: anywhere;
}
.install-error {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
.template-source {
  overflow-wrap: anywhere;
}
</style>
