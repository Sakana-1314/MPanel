<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCheckbox,
  NDrawer,
  NDrawerContent,
  NFormItem,
  NInput,
  NInputNumber,
  NSpin,
  NTabPane,
  NTabs,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui';
import type { ContainerAction } from '@/api/containers';
import type { ExecResult } from '@/api/types';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { useAction } from '@/composables/use-action';
import { usePageActive } from '@/composables/use-page-active';
import { formatBytes, formatDate, formatPercent } from '@/lib/format';
import CodeBlock from '@/components/common/CodeBlock.vue';
import ErrorState from '@/components/common/ErrorState.vue';

const props = defineProps<{
  show: boolean;
  machineId: string;
  containerId: string | null;
}>();

const emit = defineEmits<{ 'update:show': [value: boolean]; changed: [] }>();

const api = useMachineApi(() => props.machineId);
const dialog = useDialog();
const message = useMessage();
const active = usePageActive();
const tab = ref('overview');

watch(
  () => props.containerId,
  () => {
    tab.value = 'overview';
  },
);

const enabled = computed(() => props.show && props.containerId !== null);

const detailQuery = useQuery({
  queryKey: computed(() => machineKey(props.machineId, 'containers', 'detail', props.containerId ?? 'none')),
  queryFn: () => api.value.containers.get(props.containerId!),
  enabled,
  retry: 0,
});

const detail = computed(() => detailQuery.data.value);

const logsQuery = useQuery({
  queryKey: computed(() => machineKey(props.machineId, 'containers', 'logs', props.containerId ?? 'none')),
  queryFn: () => api.value.containers.logs(props.containerId!, { tail: 300, timestamps: true }),
  enabled: computed(() => enabled.value && tab.value === 'logs'),
  retry: 0,
  refetchInterval: computed(() => (enabled.value && tab.value === 'logs' && active.value ? 4_000 : false)),
});

const statsQuery = useQuery({
  queryKey: computed(() => machineKey(props.machineId, 'containers', 'stats', props.containerId ?? 'none')),
  queryFn: () => api.value.containers.stats(props.containerId!),
  enabled: computed(() => enabled.value && tab.value === 'stats'),
  retry: 0,
  refetchInterval: computed(() => (enabled.value && tab.value === 'stats' && active.value ? 5_000 : false)),
});

const invalidate = computed(() => [machineKey(props.machineId, 'containers')]);

const action = useAction((kind: ContainerAction) => api.value.containers.action(props.containerId!, kind), {
  success: (_result, kind) => `容器已${kind === 'start' ? '启动' : kind === 'stop' ? '停止' : '重启'}`,
  invalidate: invalidate.value,
});

const removeAction = useAction(
  (options: { force: boolean; removeVolumes: boolean }) =>
    api.value.containers.remove(props.containerId!, options),
  {
    success: '容器已删除',
    invalidate: invalidate.value,
  },
);

function confirmRemove(): void {
  dialog.warning({
    title: '删除容器',
    content: '将强制删除该容器（运行中也会终止），不会删除具名卷。确定继续？',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      const result = await removeAction.run({ force: true, removeVolumes: false });
      if (result !== undefined) {
        emit('changed');
        emit('update:show', false);
      }
    },
  });
}

async function runAction(kind: ContainerAction): Promise<void> {
  const result = await action.run(kind);
  if (result !== undefined) emit('changed');
}

/* --------------------------------- exec --------------------------------- */

const commandText = ref('');
const workdir = ref('');
const user = ref('');
const timeoutMs = ref<number | null>(30_000);
const execResult = ref<ExecResult | null>(null);
const execBusy = ref(false);

async function runExec(): Promise<void> {
  if (props.containerId === null) return;
  const args = commandText.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (args.length === 0) {
    message.warning('请填写命令（每行一个参数）');
    return;
  }
  execBusy.value = true;
  try {
    execResult.value = await api.value.containers.exec(props.containerId, {
      command: args,
      ...(workdir.value.trim().length > 0 ? { workdir: workdir.value.trim() } : {}),
      ...(user.value.trim().length > 0 ? { user: user.value.trim() } : {}),
      ...(timeoutMs.value !== null ? { timeoutMs: timeoutMs.value } : {}),
    });
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    execBusy.value = false;
  }
}

const stats = computed(() => statsQuery.data.value?.stats);
</script>

<template>
  <n-drawer :show="show" :width="720" placement="right" @update:show="emit('update:show', $event)">
    <n-drawer-content :title="detail?.names[0] ?? containerId ?? '容器详情'" closable>
      <n-spin v-if="detailQuery.isLoading.value" size="small" />
      <error-state v-else-if="detailQuery.isError.value" :error="detailQuery.error.value" @retry="detailQuery.refetch()" />
      <div v-else-if="detail" class="detail">
        <div class="toolbar">
          <n-tag size="small" round :bordered="false" :type="detail.state === 'running' ? 'success' : 'default'">
            {{ detail.state }}
          </n-tag>
          <span class="small muted">{{ detail.status }}</span>
          <span class="mono tiny muted">{{ detail.id.slice(0, 12) }}</span>
          <div class="spacer" />
          <n-button size="tiny" type="primary" secondary :disabled="detail.state === 'running'" :loading="action.pending.value" @click="runAction('start')">启动</n-button>
          <n-button size="tiny" secondary :disabled="detail.state !== 'running'" :loading="action.pending.value" @click="runAction('stop')">停止</n-button>
          <n-button size="tiny" secondary :loading="action.pending.value" @click="runAction('restart')">重启</n-button>
          <n-button size="tiny" quaternary type="error" @click="confirmRemove">删除</n-button>
        </div>

        <n-tabs v-model:value="tab" type="segment" animated>
          <n-tab-pane name="overview" tab="概览">
            <div class="kv">
              <dt>镜像</dt><dd class="mono">{{ detail.image }}</dd>
              <dt>命令</dt><dd class="mono">{{ detail.command ?? '—' }}</dd>
              <dt>创建时间</dt><dd>{{ formatDate(detail.created) }}</dd>
              <dt>重启策略</dt><dd>{{ detail.restartPolicy ?? '—' }}</dd>
              <dt>网络模式</dt><dd>{{ detail.networkMode ?? '—' }}</dd>
              <dt>健康</dt><dd>{{ detail.health ?? '—' }}</dd>
              <dt>平台</dt><dd>{{ detail.platform ?? '—' }}</dd>
              <dt>Compose</dt><dd>{{ detail.composeProject ?? '—' }} / {{ detail.composeService ?? '—' }}</dd>
            </div>
            <div class="section">
              <div class="section-title">端口</div>
              <div class="toolbar">
                <n-tag v-for="port in detail.ports" :key="`${port.privatePort}/${port.type}`" size="tiny" :bordered="false" class="mono">
                  {{ port.publicPort ? `${port.publicPort} → ` : '' }}{{ port.privatePort }}/{{ port.type }}
                </n-tag>
                <span v-if="detail.ports.length === 0" class="tiny muted">无</span>
              </div>
            </div>
            <div class="section">
              <div class="section-title">挂载</div>
              <div class="kv">
                <template v-for="mount in detail.mounts" :key="mount.destination">
                  <dt>{{ mount.type }}</dt>
                  <dd class="mono tiny">{{ mount.source ?? '—' }} → {{ mount.destination }} ({{ mount.mode ?? (mount.rw ? 'rw' : 'ro') }})</dd>
                </template>
                <span v-if="detail.mounts.length === 0" class="tiny muted">无</span>
              </div>
            </div>
            <div class="section">
              <div class="section-title">环境变量</div>
              <code-block :text="detail.env.join('\n') || '（空）'" max-height="220px" />
            </div>
          </n-tab-pane>

          <n-tab-pane name="logs" tab="日志">
            <div class="toolbar" style="margin-bottom: 8px">
              <span class="small muted">最近 300 行 · 每 4 秒刷新</span>
              <div class="spacer" />
              <n-button size="tiny" secondary :loading="logsQuery.isFetching.value" @click="logsQuery.refetch()">刷新</n-button>
            </div>
            <error-state v-if="logsQuery.isError.value" :error="logsQuery.error.value" @retry="logsQuery.refetch()" />
            <n-spin v-else-if="logsQuery.isLoading.value" size="small" />
            <code-block v-else :text="logsQuery.data.value?.logs || '（无日志）'" max-height="520px" />
          </n-tab-pane>

          <n-tab-pane name="stats" tab="统计">
            <div class="toolbar" style="margin-bottom: 8px">
              <span class="small muted">每 5 秒刷新</span>
              <div class="spacer" />
              <n-button size="tiny" secondary :loading="statsQuery.isFetching.value" @click="statsQuery.refetch()">刷新</n-button>
            </div>
            <error-state v-if="statsQuery.isError.value" :error="statsQuery.error.value" @retry="statsQuery.refetch()" />
            <div v-else-if="stats" class="kv">
              <dt>CPU</dt><dd>{{ formatPercent(stats.cpuPercent) }}</dd>
              <dt>内存</dt><dd>{{ formatBytes(stats.memoryUsageBytes) }} / {{ formatBytes(stats.memoryLimitBytes) }}（{{ formatPercent(stats.memoryPercent) }}）</dd>
              <dt>网络</dt><dd>RX {{ formatBytes(stats.networkRxBytes) }} · TX {{ formatBytes(stats.networkTxBytes) }}</dd>
              <dt>块设备</dt><dd>读 {{ formatBytes(stats.blockReadBytes) }} · 写 {{ formatBytes(stats.blockWriteBytes) }}</dd>
              <dt>PID</dt><dd>{{ stats.pids }}</dd>
              <dt>采样时间</dt><dd>{{ formatDate(stats.readAt) }}</dd>
            </div>
            <n-alert v-else type="info" :bordered="false">容器未运行或暂无统计。</n-alert>
          </n-tab-pane>

          <n-tab-pane name="exec" tab="执行">
            <n-alert type="warning" :bordered="true" title="容器内执行">
              命令以数组参数执行，不经过 shell。每行一个参数，例如：<code>ls</code> / <code>-la</code> / <code>/app</code>。
            </n-alert>
            <n-form-item label="命令参数（每行一个）">
              <n-input v-model:value="commandText" type="textarea" :rows="4" class="mono" placeholder="sh&#10;-c&#10;echo hello" />
            </n-form-item>
            <div class="two">
              <n-form-item label="工作目录">
                <n-input v-model:value="workdir" placeholder="/app（可选）" />
              </n-form-item>
              <n-form-item label="用户">
                <n-input v-model:value="user" placeholder="root（可选）" />
              </n-form-item>
              <n-form-item label="超时（毫秒）">
                <n-input-number v-model:value="timeoutMs" :min="1" :max="600000" style="width: 100%" />
              </n-form-item>
            </div>
            <n-button type="primary" :loading="execBusy" @click="runExec">执行</n-button>
            <template v-if="execResult">
              <div class="kv" style="margin-top: 12px">
                <dt>退出码</dt><dd>{{ execResult.exitCode ?? '—' }}</dd>
                <dt>耗时</dt><dd>{{ execResult.durationMs }} ms</dd>
                <dt>截断</dt><dd>{{ execResult.truncated ? '是' : '否' }}</dd>
              </div>
              <div class="section-title">stdout</div>
              <code-block :text="execResult.stdout || '（空）'" max-height="220px" />
              <div class="section-title">stderr</div>
              <code-block :text="execResult.stderr || '（空）'" max-height="180px" />
            </template>
          </n-tab-pane>
        </n-tabs>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.section {
  margin-top: 14px;
}
.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--mpanel-muted);
  margin-bottom: 4px;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}
</style>
