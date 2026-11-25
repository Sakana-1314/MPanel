<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSwitch,
  NTag,
} from 'naive-ui';
import type {
  Machine,
  MachineCreateInput,
  MachineCreateResult,
  MachineTransport,
  MachineUpdateInput,
} from '@/api/types';
import { useCoreApi } from '@/lib/api';
import { useAction } from '@/composables/use-action';
import { coreKey } from '@/lib/query-keys';
import { formatDate } from '@/lib/format';

const props = defineProps<{
  show: boolean;
  machine?: Machine;
}>();

const emit = defineEmits<{
  'update:show': [value: boolean];
  saved: [result: MachineCreateResult];
}>();

const api = useCoreApi();
const isEdit = computed(() => props.machine !== undefined);
const hasToken = computed(() => props.machine?.hasToken === true);

const name = ref('');
const enabled = ref(true);
const transport = ref<MachineTransport>('http');
const url = ref('');
const token = ref('');
const command = ref('');
const argsText = ref('');
const envText = ref('');
const formError = ref<string | null>(null);

const RESERVED_ENV_KEYS = new Set([
  'MPANEL_TRANSPORT',
  'MPANEL_TOKEN',
  'MPANEL_HOME',
  'MPANEL_CORE_URL',
  'MPANEL_MACHINE_ID',
  'MPANEL_MACHINE_SECRET',
]);

watch(
  () => [props.show, props.machine?.id] as const,
  ([show]) => {
    if (!show) return;
    const machine = props.machine;
    name.value = machine?.name ?? '';
    enabled.value = machine?.enabled ?? true;
    transport.value = machine?.transport ?? 'http';
    url.value = machine?.endpoint ?? '';
    token.value = '';
    command.value = '';
    argsText.value = '';
    envText.value = '';
    formError.value = null;
  },
  { immediate: true },
);

const transportOptions = [
  { label: 'http · 直连 agent URL', value: 'http' },
  { label: 'stdio · core 拉起本地进程', value: 'stdio' },
  { label: 'reverse-ws · agent 主动连回 core', value: 'reverse-ws' },
];

function parseEnvText(text: string): { value?: Record<string, string>; error?: string } {
  const result: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) return { error: `环境变量第 ${index + 1} 行应形如 KEY=VALUE。` };
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { error: `环境变量名不合法：${key}` };
    if (RESERVED_ENV_KEYS.has(key)) {
      return { error: `${key} 是 core 注入的保留键，不能在这里填写。` };
    }
    result[key] = value;
  }
  return { value: result };
}

const envParsed = computed(() => parseEnvText(envText.value));
const args = computed(() =>
  argsText.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0),
);

const tokenRequired = computed(
  () => transport.value === 'http' || transport.value === 'stdio',
);

const invalidate = computed(() => [
  coreKey('machines', 'list', { limit: 200 }),
  coreKey('system', 'overview'),
  ...(props.machine === undefined ? [] : [coreKey('machines', 'detail', props.machine.id)]),
]);

const createAction = useAction(
  (input: MachineCreateInput) => api.value.machines.create(input),
  {
    success: (result) => `已创建机器 ${result.machine.name}`,
    successDescription: (result) =>
      result.enrollment === undefined ? 'core 已开始连接该机器。' : '请立即保存一次性注册信息。',
    invalidate: invalidate.value,
  },
);

const updateAction = useAction(
  (input: { id: string; body: MachineUpdateInput }) =>
    api.value.machines.update(input.id, input.body),
  {
    success: (machine) => `已保存机器 ${machine.name}`,
    invalidate: invalidate.value,
  },
);

const submitting = computed(() => createAction.pending.value || updateAction.pending.value);
const actionError = computed(() => createAction.error.value ?? updateAction.error.value);

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function validate(): string | null {
  if (name.value.trim().length === 0) return '请填写机器名称。';
  if (transport.value === 'http') {
    const normalized = normalizeUrl(url.value);
    if (normalized.length === 0) return '请填写 agent 的 HTTP URL。';
    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return 'agent URL 必须是 http:// 或 https:// 开头。';
      }
    } catch {
      return 'agent URL 格式不正确，例如 http://127.0.0.1:10087。';
    }
  }
  if (transport.value === 'stdio' && envParsed.value.error !== undefined) {
    return envParsed.value.error;
  }
  if (tokenRequired.value) {
    const requiresNew = !isEdit.value || !hasToken.value;
    if (requiresNew && token.value.trim().length === 0) {
      return transport.value === 'http'
        ? 'http 机器需要 agent 的 MPANEL_TOKEN。'
        : 'stdio 机器需要注入给 agent 的 MPANEL_TOKEN。';
    }
  }
  return null;
}

function buildCreateInput(): MachineCreateInput {
  const base = { name: name.value.trim(), enabled: enabled.value };
  if (transport.value === 'http') {
    return { ...base, transport: 'http', url: normalizeUrl(url.value), token: token.value.trim() };
  }
  if (transport.value === 'stdio') {
    return {
      ...base,
      transport: 'stdio',
      command: command.value.trim().length === 0 ? undefined : command.value.trim(),
      args: args.value.length === 0 ? undefined : args.value,
      env: envParsed.value.value,
      token: token.value.trim(),
    };
  }
  return { ...base, transport: 'reverse-ws' };
}

function buildUpdateInput(): MachineUpdateInput {
  const base: MachineUpdateInput = { name: name.value.trim(), enabled: enabled.value };
  if (transport.value === 'http') {
    base.url = normalizeUrl(url.value);
    if (token.value.trim().length > 0) base.token = token.value.trim();
    return base;
  }
  if (transport.value === 'stdio') {
    if (command.value.trim().length > 0) base.command = command.value.trim();
    // 机器详情不回显 args/env；留空表示保持不变。
    if (argsText.value.trim().length > 0) base.args = args.value;
    if (envText.value.trim().length > 0) base.env = envParsed.value.value;
    if (token.value.trim().length > 0) base.token = token.value.trim();
    return base;
  }
  return base;
}

async function submit(): Promise<void> {
  const problem = validate();
  if (problem !== null) {
    formError.value = problem;
    return;
  }
  formError.value = null;
  if (isEdit.value && props.machine !== undefined) {
    const updated = await updateAction.run({ id: props.machine.id, body: buildUpdateInput() });
    if (updated !== undefined) {
      emit('saved', { machine: updated });
      emit('update:show', false);
    }
    return;
  }
  const created = await createAction.run(buildCreateInput());
  if (created !== undefined) {
    emit('saved', created);
    emit('update:show', false);
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="isEdit ? `编辑机器 · ${machine?.name ?? ''}` : '新增机器'"
    style="width: 680px; max-width: calc(100vw - 24px)"
    :mask-closable="!submitting"
    @update:show="emit('update:show', $event)"
  >
    <div class="form">
      <div v-if="isEdit && machine" class="toolbar">
        <n-tag size="small" type="info" round :bordered="false">{{ machine.transport }}</n-tag>
        <span class="tiny muted">创建于 {{ formatDate(machine.createdAt) }}</span>
        <span class="tiny muted">· 更新于 {{ formatDate(machine.updatedAt) }}</span>
        <n-tag v-if="hasToken" size="small" type="success" round :bordered="false">已保存 token</n-tag>
      </div>

      <div class="two">
        <n-form-item label="名称" required>
          <n-input v-model:value="name" placeholder="例如：生产 VPS / 本地 docker" />
        </n-form-item>
        <n-form-item label="启用">
          <n-switch v-model:value="enabled" />
          <span class="small muted" style="margin-left: 8px">{{ enabled ? '已启用' : '已禁用' }}</span>
        </n-form-item>
      </div>

      <n-form-item label="传输类型" required>
        <n-select
          v-model:value="transport"
          :disabled="isEdit"
          :options="transportOptions"
        />
      </n-form-item>
      <p class="tiny muted" style="margin: -8px 0 4px">
        契约不允许修改传输类型；换传输请新建机器。
      </p>

      <template v-if="transport === 'http'">
        <n-alert type="info" :bordered="true" title="http 传输">
          core 直连 agent 的 HTTP API；创建后立即探测 /system/info，失败不阻止创建。
        </n-alert>
        <n-form-item label="agent URL" required>
          <n-input v-model:value="url" placeholder="http://127.0.0.1:10087" />
        </n-form-item>
      </template>

      <template v-if="transport === 'stdio'">
        <n-alert type="warning" :bordered="true" title="stdio 传输需要显式开启">
          core 会拉起本地 agent 进程（等同宿主命令执行能力），需要 MPANEL_ALLOW_STDIO=1。
        </n-alert>
        <n-form-item label="命令">
          <n-input v-model:value="command" placeholder="mpanel-agent" />
        </n-form-item>
        <n-form-item label="参数（每行一个）">
          <n-input
            v-model:value="argsText"
            type="textarea"
            :rows="3"
            class="mono"
            :placeholder="isEdit ? '留空表示保持不变' : '--config\n/opt/mpanel/conf/agent.yaml'"
          />
        </n-form-item>
        <n-form-item label="环境变量（每行 KEY=VALUE）" :feedback="envParsed.error">
          <n-input
            v-model:value="envText"
            type="textarea"
            :rows="4"
            class="mono"
            :placeholder="isEdit ? '留空表示保持不变' : 'NODE_OPTIONS=--max-old-space-size=512'"
          />
        </n-form-item>
      </template>

      <n-alert v-if="transport === 'reverse-ws'" type="info" :bordered="true" title="reverse-ws 传输">
        创建后 core 生成 machine secret 与注册地址；agent 主动连回 core，core 不主动拨号。
        secret 只显示一次。
      </n-alert>

      <n-form-item
        v-if="transport === 'http' || transport === 'stdio'"
        label="agent token"
        :required="!isEdit || !hasToken"
      >
        <n-input
          v-model:value="token"
          type="password"
          show-password-on="click"
          :placeholder="isEdit && hasToken ? '••••••（保持不变）' : 'MPANEL_TOKEN'"
        />
      </n-form-item>

      <n-alert v-if="formError" type="error" :bordered="true" title="请检查表单">
        {{ formError }}
      </n-alert>
      <n-alert
        v-if="actionError"
        type="error"
        :bordered="true"
        :title="actionError.message"
      >
        {{ actionError.hint }}
      </n-alert>
    </div>

    <template #footer>
      <div class="toolbar" style="justify-content: flex-end">
        <n-button quaternary :disabled="submitting" @click="emit('update:show', false)">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="submit">
          {{ isEdit ? '保存' : '创建机器' }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.two {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 160px;
  gap: 12px;
}
@media (max-width: 560px) {
  .two {
    grid-template-columns: 1fr;
  }
}
</style>
