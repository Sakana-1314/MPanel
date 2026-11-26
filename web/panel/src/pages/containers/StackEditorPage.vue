<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCard,
  NIcon,
  NInput,
  NSpin,
  NTag,
} from 'naive-ui';
import { ArrowBackOutline, SaveOutline } from '@vicons/ionicons5';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { useAction } from '@/composables/use-action';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import CodeEditor from '@/components/common/CodeEditor.vue';

const route = useRoute();
const router = useRouter();
const machineId = String(route.params.machineId ?? '');
const stackName = String(route.params.stackName ?? '');
const api = useMachineApi(machineId);

const yaml = ref('');
const name = ref(stackName);
const initialYaml = ref('');
const dirty = computed(() => yaml.value !== initialYaml.value);

const stackQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'stacks', 'detail', stackName)),
  queryFn: () => api.value.stacks.get(stackName),
  retry: 1,
});

watch(
  () => stackQuery.data.value?.composeYaml,
  (value) => {
    if (value === undefined) return;
    yaml.value = value;
    initialYaml.value = value;
  },
  { immediate: true },
);

const saveAction = useAction(
  () => api.value.stacks.update(stackName, { composeYaml: yaml.value }),
  {
    success: '栈配置已保存',
    successDescription: '修改不会自动应用；请在详情页执行 up/restart。',
    invalidate: [machineKey(machineId, 'stacks')],
  },
);

async function save(): Promise<void> {
  const result = await saveAction.run();
  if (result !== undefined) {
    initialYaml.value = yaml.value;
    await router.push(`/m/${machineId}/stacks/${encodeURIComponent(stackName)}`);
  }
}
</script>

<template>
  <div class="page">
    <div class="back">
      <n-button size="small" quaternary @click="router.push(`/m/${machineId}/stacks/${encodeURIComponent(stackName)}`)">
        <template #icon><n-icon :component="ArrowBackOutline" /></template>
        栈详情
      </n-button>
    </div>

    <PageHeader :title="`编辑编排 · ${stackName}`">
      <template #meta>
        <n-tag v-if="dirty" size="small" type="warning" round :bordered="false">未保存</n-tag>
      </template>
      <template #actions>
        <n-button size="small" type="primary" :loading="saveAction.pending.value" @click="save">
          <template #icon><n-icon :component="SaveOutline" /></template>
          保存配置
        </n-button>
      </template>
    </PageHeader>

    <error-state v-if="stackQuery.isError.value" :error="stackQuery.error.value" @retry="stackQuery.refetch()" />
    <n-spin v-else-if="stackQuery.isLoading.value" size="small">
      <div style="height: 100px" />
    </n-spin>

    <template v-else>
      <n-card size="small">
        <div class="toolbar">
          <n-input v-model:value="name" disabled style="max-width: 260px" />
          <span class="tiny muted">栈名称创建后不可修改。</span>
        </div>
      </n-card>
      <n-card size="small" title="compose.yaml">
        <code-editor v-model="yaml" language="text" height="560px" />
      </n-card>
      <n-alert v-if="saveAction.error.value" type="error" :bordered="true" title="保存失败">
        {{ saveAction.error.value.message }} {{ saveAction.error.value.hint }}
      </n-alert>
    </template>
  </div>
</template>

<style scoped>
.back {
  margin-bottom: -6px;
}
</style>
