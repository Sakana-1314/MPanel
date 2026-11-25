<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NIcon,
  NTag,
} from 'naive-ui';
import { RefreshOutline, OpenOutline } from '@vicons/ionicons5';
import { useMachineQuery } from '@/lib/machines';
import { useCoreApi } from '@/lib/api';
import { useAction } from '@/composables/use-action';
import { coreKey } from '@/lib/query-keys';
import { formatBytes, formatDate, formatUptime } from '@/lib/format';
import { MACHINE_AREAS, openMachinePage } from '@/lib/navigation';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import MachineStatusTag from '@/components/common/MachineStatusTag.vue';
import RelativeTime from '@/components/common/RelativeTime.vue';

const route = useRoute();
const machineId = String(route.params.machineId ?? '');
const machineQuery = useMachineQuery(machineId);
const api = useCoreApi();
const machine = computed(() => machineQuery.data.value);

const connectAction = useAction(() => api.value.machines.connect(machineId), {
  success: '已请求连接机器',
  invalidate: [coreKey('machines', 'list', { limit: 200 }), coreKey('machines', 'detail', machineId)],
});

const testResult = ref<string | null>(null);
const testAction = useAction(() => api.value.machines.test(machineId), {
  success: (result) => (result.reachable ? `可达 · ${result.latencyMs ?? '?'} ms` : `不可达：${result.error ?? ''}`),
  invalidate: [coreKey('machines', 'detail', machineId)],
});

async function test(): Promise<void> {
  const result = await testAction.run();
  if (result !== undefined) {
    testResult.value = result.reachable
      ? `可达 · ${result.latencyMs ?? '?'} ms`
      : `不可达 · ${result.error ?? '未知错误'}`;
  }
}

const capabilities = computed(() => {
  const caps = machine.value?.capabilities;
  if (caps === null || caps === undefined) return [];
  return (Object.keys(caps) as Array<keyof typeof caps>).map((key) => ({
    key,
    status: caps[key],
  }));
});

const snapshot = computed(() => machine.value?.snapshot ?? null);
</script>

<template>
  <div class="page">
    <PageHeader
      title="机器详情"
      :subtitle="machineId"
    >
      <template #actions>
        <n-button size="small" secondary :loading="machineQuery.isFetching.value" @click="machineQuery.refetch()">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          刷新
        </n-button>
        <n-button size="small" secondary :loading="testAction.pending.value" @click="test">测试连接</n-button>
        <n-button size="small" type="primary" @click="openMachinePage(machineId, 'sites')">
          <template #icon><n-icon :component="OpenOutline" /></template>
          打开工作台
        </n-button>
      </template>
    </PageHeader>

    <error-state
      v-if="machineQuery.isError.value"
      :error="machineQuery.error.value"
      @retry="machineQuery.refetch()"
    />

    <template v-if="machine">
      <n-card size="small">
        <div class="top">
          <div>
            <div class="title-row">
              <strong class="name">{{ machine.name }}</strong>
              <MachineStatusTag :status="machine.status" />
              <n-tag size="tiny" round :bordered="false">{{ machine.transport }}</n-tag>
              <n-tag v-if="machine.edge" size="tiny" type="info" round :bordered="false">edge</n-tag>
              <n-tag v-if="machine.group" size="tiny" round :bordered="false">{{ machine.group }}</n-tag>
            </div>
            <div class="tiny muted" style="margin-top: 4px">
              {{ machine.endpoint ?? 'stdio 本地进程' }} · 心跳 <RelativeTime :value="machine.lastSeenAt" />
            </div>
          </div>
          <div class="toolbar">
            <n-button
              v-if="machine.status !== 'online'"
              size="small"
              type="primary"
              secondary
              :loading="connectAction.pending.value"
              @click="connectAction.run()"
            >
              连接
            </n-button>
            <n-button size="small" quaternary @click="testAction.run()">快速测试</n-button>
          </div>
        </div>

        <n-alert
          v-if="machine.lastError"
          type="warning"
          :bordered="true"
          title="最近错误"
          style="margin-top: 12px"
        >
          {{ machine.lastError }}
        </n-alert>

        <div class="descriptions">
          <n-descriptions label-placement="left" bordered size="small" :column="2">
            <n-descriptions-item label="机器 ID"><span class="mono">{{ machine.id }}</span></n-descriptions-item>
            <n-descriptions-item label="传输">{{ machine.transport }}</n-descriptions-item>
            <n-descriptions-item label="启用">{{ machine.enabled ? '是' : '否' }}</n-descriptions-item>
            <n-descriptions-item label="期望状态">{{ machine.desiredState }}</n-descriptions-item>
            <n-descriptions-item label="创建时间">{{ formatDate(machine.createdAt) }}</n-descriptions-item>
            <n-descriptions-item label="更新时间">{{ formatDate(machine.updatedAt) }}</n-descriptions-item>
            <n-descriptions-item label="agent" :span="2">
              <template v-if="machine.worker">
                {{ machine.worker.name }} v{{ machine.worker.version }} ·
                {{ machine.worker.platform }}/{{ machine.worker.arch }} ·
                API v{{ machine.worker.apiVersion }} · 协议 v{{ machine.worker.protocolVersion }}
              </template>
              <span v-else class="muted">尚未上报</span>
            </n-descriptions-item>
            <n-descriptions-item v-if="testResult !== null" label="测试结果" :span="2">
              {{ testResult }}
            </n-descriptions-item>
          </n-descriptions>
        </div>

        <div class="caps">
          <span class="tiny muted">能力：</span>
          <n-tag
            v-for="cap in capabilities"
            :key="cap.key"
            size="small"
            round
            :bordered="false"
            :type="cap.status.available ? 'success' : 'default'"
            :title="cap.status.reason"
          >
            {{ cap.key }}<template v-if="cap.status.version"> {{ cap.status.version }}</template>
          </n-tag>
          <span v-if="capabilities.length === 0" class="tiny muted">capabilities 尚未上报</span>
        </div>
      </n-card>

      <div class="split">
        <n-card size="small" title="节点快照">
          <template v-if="snapshot">
            <n-descriptions label-placement="left" bordered size="small" :column="1">
              <n-descriptions-item label="主机名">{{ snapshot.hostname }}</n-descriptions-item>
              <n-descriptions-item label="平台">{{ snapshot.platform }}/{{ snapshot.arch }}</n-descriptions-item>
              <n-descriptions-item label="发行版">{{ snapshot.release }}</n-descriptions-item>
              <n-descriptions-item label="CPU">{{ snapshot.cpuCount }} 核</n-descriptions-item>
              <n-descriptions-item label="负载">
                {{ snapshot.loadavg ? snapshot.loadavg.map((v) => v.toFixed(2)).join(' / ') : '—' }}
              </n-descriptions-item>
              <n-descriptions-item label="内存">
                {{ formatBytes(snapshot.memTotalBytes - snapshot.memFreeBytes) }} /
                {{ formatBytes(snapshot.memTotalBytes) }}
              </n-descriptions-item>
              <n-descriptions-item label="磁盘">
                <template v-if="snapshot.diskTotalBytes !== null && snapshot.diskFreeBytes !== null">
                  {{ formatBytes(snapshot.diskTotalBytes - snapshot.diskFreeBytes) }} /
                  {{ formatBytes(snapshot.diskTotalBytes) }}
                </template>
                <span v-else class="muted">未知</span>
              </n-descriptions-item>
              <n-descriptions-item label="运行时长">{{ formatUptime(snapshot.uptimeSec) }}</n-descriptions-item>
              <n-descriptions-item label="IP">{{ snapshot.ips.join(', ') || '—' }}</n-descriptions-item>
              <n-descriptions-item label="采集时间">{{ formatDate(snapshot.collectedAt) }}</n-descriptions-item>
            </n-descriptions>
          </template>
          <n-alert v-else type="info" :bordered="false">
            core 尚未采集到该机器的节点快照；机器在线后会自动刷新。
          </n-alert>
        </n-card>

        <n-card size="small" title="打开该机器的页面">
          <p class="small muted" style="margin-top: 0">
            每个入口会新建（或聚焦）一个工作台标签页；同一台机器的多个页面可以同时打开，
            其它机器的标签也不会被替换。
          </p>
          <div class="area-grid">
            <n-button
              v-for="area in MACHINE_AREAS"
              :key="area.area"
              size="small"
              secondary
              @click="openMachinePage(machineId, area.area)"
            >
              {{ area.title }}
            </n-button>
          </div>
        </n-card>
      </div>
    </template>
  </div>
</template>

<style scoped>
.top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.name {
  font-size: 16px;
}
.descriptions {
  margin-top: 12px;
}
.caps {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.area-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
}
</style>
