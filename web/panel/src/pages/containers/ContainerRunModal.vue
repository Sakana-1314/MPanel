<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  useMessage,
} from 'naive-ui';
import type { ContainerCreated, ContainerCreateInput } from '@/api/types';
import { useMachineApi } from '@/lib/api';
import { describeError } from '@/api/errors';
import { machineKey } from '@/lib/query-keys';
import { openJobProgress } from '@/lib/job-center';

export interface ContainerRunPreset {
  /** 弹窗标题，例如「运行 PostgreSQL 容器」。 */
  title: string;
  /** 预填的镜像与参数；用户仍可修改。 */
  input: Partial<ContainerCreateInput>;
  /** 表单上方的说明，一句话。 */
  hint?: string;
}

const props = defineProps<{
  show: boolean;
  machineId: string;
  preset?: ContainerRunPreset;
}>();

const emit = defineEmits<{ 'update:show': [value: boolean]; created: [] }>();

const api = useMachineApi(() => props.machineId);
const message = useMessage();

interface PortRow {
  host: string;
  container: string;
  protocol: 'tcp' | 'udp';
}

const form = reactive({
  image: '',
  name: '',
  restart: 'unless-stopped',
  network: '',
  envText: '',
  ports: [] as PortRow[],
  volumeText: '',
});

const submitting = ref(false);
const error = ref<string | null>(null);

const restartOptions = [
  { label: '除非手动停止（unless-stopped）', value: 'unless-stopped' },
  { label: '总是重启（always）', value: 'always' },
  { label: '不自动重启（no）', value: 'no' },
  { label: '失败时重启（on-failure）', value: 'on-failure' },
];

watch(
  () => props.show,
  (show) => {
    if (!show) return;
    const preset = props.preset;
    error.value = null;
    form.image = preset?.input.image ?? '';
    form.name = preset?.input.name ?? '';
    form.restart = preset?.input.restart ?? 'unless-stopped';
    form.network = preset?.input.network ?? '';
    form.envText = Object.entries(preset?.input.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    form.volumeText = (preset?.input.volumes ?? []).join('\n');
    form.ports = parsePorts(preset?.input.ports ?? []);
    if (form.ports.length === 0) form.ports = [{ host: '', container: '', protocol: 'tcp' }];
  },
  { immediate: true },
);

function parsePorts(ports: string[]): PortRow[] {
  const rows: PortRow[] = [];
  for (const item of ports) {
    const [mapping, protocol] = item.split('/');
    const [host = '', container = ''] = mapping.split(':');
    rows.push({
      host,
      container,
      protocol: protocol === 'udp' ? 'udp' : 'tcp',
    });
  }
  return rows;
}

function addPort(): void {
  form.ports.push({ host: '', container: '', protocol: 'tcp' });
}

function removePort(index: number): void {
  form.ports.splice(index, 1);
  if (form.ports.length === 0) form.ports.push({ host: '', container: '', protocol: 'tcp' });
}

const envPairs = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  for (const line of form.envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return out;
});

function buildInput(): ContainerCreateInput {
  const ports = form.ports
    .filter((row) => row.host.trim().length > 0 && row.container.trim().length > 0)
    .map((row) => `${row.host.trim()}:${row.container.trim()}/${row.protocol}`);
  const volumes = form.volumeText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return {
    image: form.image.trim(),
    name: form.name.trim() || undefined,
    restart: form.restart,
    network: form.network.trim() || undefined,
    env: Object.keys(envPairs.value).length > 0 ? envPairs.value : undefined,
    ports: ports.length > 0 ? ports : undefined,
    volumes: volumes.length > 0 ? volumes : undefined,
  };
}

const canSubmit = computed(() => form.image.trim().length > 0 && !submitting.value);

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  error.value = null;
  submitting.value = true;
  try {
    const started = await api.value.containers.createAsync(buildInput());
    emit('update:show', false);
    openJobProgress({
      machineId: props.machineId,
      jobId: started.job.id,
      title: started.job.title,
      invalidate: [machineKey(props.machineId, 'containers')],
      onCompleted: (job) => {
        const created = job.result as ContainerCreated | undefined;
        message.success(created?.name ? `已启动容器 ${created.name}` : '容器已启动');
        emit('created');
      },
    });
  } catch (err) {
    error.value = describeError(err).description;
  } finally {
    submitting.value = false;
  }
}

function close(): void {
  emit('update:show', false);
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="preset?.title ?? '运行容器'"
    :bordered="false"
    style="width: 660px; max-width: calc(100vw - 24px)"
    @update:show="emit('update:show', $event)"
  >
    <div class="form">
      <p v-if="preset?.hint" class="hint">{{ preset.hint }}</p>

      <div class="two">
        <n-form-item label="镜像" required>
          <n-input v-model:value="form.image" placeholder="例如 postgres:16、redis:7-alpine" />
        </n-form-item>
        <n-form-item label="容器名">
          <n-input v-model:value="form.name" placeholder="留空则自动生成" />
        </n-form-item>
      </div>

      <n-form-item label="端口映射">
        <div class="ports">
          <div v-for="(row, index) in form.ports" :key="index" class="port-row">
            <n-input v-model:value="row.host" placeholder="宿主端口，如 5432" />
            <span class="port-sep">:</span>
            <n-input v-model:value="row.container" placeholder="容器端口，如 5432" />
            <n-select
              v-model:value="row.protocol"
              class="port-proto"
              :options="[
                { label: 'tcp', value: 'tcp' },
                { label: 'udp', value: 'udp' },
              ]"
            />
            <n-button quaternary size="small" @click="removePort(index)">移除</n-button>
          </div>
          <n-button size="small" secondary @click="addPort">添加端口</n-button>
        </div>
      </n-form-item>

      <n-form-item label="环境变量">
        <n-input
          v-model:value="form.envText"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 8 }"
          placeholder="每行一个，例如 POSTGRES_PASSWORD=change-me"
        />
      </n-form-item>

      <n-form-item label="卷挂载">
        <n-input
          v-model:value="form.volumeText"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 6 }"
          placeholder="每行一个，例如 /opt/mpanel/data/pg:/var/lib/postgresql/data"
        />
      </n-form-item>

      <div class="two">
        <n-form-item label="重启策略">
          <n-select v-model:value="form.restart" :options="restartOptions" />
        </n-form-item>
        <n-form-item label="网络">
          <n-input v-model:value="form.network" placeholder="留空使用默认 bridge" />
        </n-form-item>
      </div>

      <n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>
    </div>

    <template #footer>
      <div class="footer">
        <n-button quaternary @click="close">取消</n-button>
        <n-button type="primary" :disabled="!canSubmit" :loading="submitting" @click="submit">
          启动容器
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hint {
  margin: 0 0 6px;
  font-size: 12.5px;
  color: var(--mpanel-muted);
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}
@media (max-width: 560px) {
  .two {
    grid-template-columns: 1fr;
  }
}
.ports {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.port-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.port-sep {
  color: var(--mpanel-muted);
}
.port-proto {
  width: 92px;
  flex: 0 0 auto;
}
.footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
