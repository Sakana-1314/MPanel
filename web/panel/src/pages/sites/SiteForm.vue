<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NFormItem,
  NIcon,
  NInput,
  NSelect,
  NSwitch,
} from 'naive-ui';
import { AddOutline, TrashOutline } from '@vicons/ionicons5';
import type {
  FileServerHandler,
  RedirectHandler,
  ReverseProxyHandler,
  SiteHandler,
} from '@/api/types';
import {
  defaultHandler,
  parseCommaList,
  validateSiteDraft,
  type SiteDraft,
} from './site-form';

const props = withDefaults(
  defineProps<{
    draft: SiteDraft;
    submitting?: boolean;
    submitLabel?: string;
    previewLoading?: boolean;
    showCancel?: boolean;
  }>(),
  {
    submitting: false,
    submitLabel: '保存',
    previewLoading: false,
    showCancel: true,
  },
);

const emit = defineEmits<{
  submit: [];
  preview: [];
  cancel: [];
}>();

const error = ref<string | null>(null);

const handler = computed(() => props.draft.config.handler);

function setHandlerType(type: SiteHandler['type']): void {
  if (props.draft.config.handler.type === type) return;
  props.draft.config.handler = defaultHandler(type);
}

function patchRedirect(patch: Partial<Omit<RedirectHandler, 'type'>>): void {
  const value = props.draft.config.handler;
  if (value.type === 'redirect') Object.assign(value, patch);
}

const listenText = computed({
  get: () => (props.draft.config.listen ?? []).join(', '),
  set: (value: string) => {
    props.draft.config.listen = parseCommaList(value);
  },
});

const tlsMode = computed({
  get: () => props.draft.config.tls?.mode ?? 'auto',
  set: (mode: 'auto' | 'internal' | 'off') => {
    props.draft.config.tls =
      mode === 'auto' ? { mode, email: props.draft.config.tls?.email } : { mode };
  },
});

const email = computed({
  get: () => props.draft.config.tls?.email ?? '',
  set: (value: string) => {
    props.draft.config.tls = { mode: 'auto', email: value.trim().length === 0 ? undefined : value };
  },
});

function toggleEncode(encoding: 'gzip' | 'zstd', checked: boolean): void {
  const current = new Set(props.draft.config.encode ?? []);
  if (checked) current.add(encoding);
  else current.delete(encoding);
  props.draft.config.encode = current.size === 0 ? undefined : ([...current] as ('gzip' | 'zstd')[]);
}

function togglePrecompressed(encoding: 'gzip' | 'zstd', checked: boolean): void {
  const value = props.draft.config.handler;
  if (value.type !== 'file_server') return;
  const current = new Set(value.precompressed ?? []);
  if (checked) current.add(encoding);
  else current.delete(encoding);
  value.precompressed = current.size === 0 ? undefined : ([...current] as ('gzip' | 'zstd')[]);
}

/* --------------------------- domains / upstreams --------------------------- */

function addDomain(): void {
  if (props.draft.config.domains.length >= 50) return;
  props.draft.config.domains.push('');
}

function removeDomain(index: number): void {
  if (props.draft.config.domains.length <= 1) return;
  props.draft.config.domains.splice(index, 1);
}

function addUpstream(): void {
  const value = props.draft.config.handler;
  if (value.type === 'reverse_proxy') value.upstreams.push('');
}

function removeUpstream(index: number): void {
  const value = props.draft.config.handler;
  if (value.type !== 'reverse_proxy' || value.upstreams.length <= 1) return;
  value.upstreams.splice(index, 1);
}

/* -------------------------------- headers -------------------------------- */

interface HeaderRow {
  key: string;
  value: string;
}

function rowsOf(headers: Record<string, string> | undefined): HeaderRow[] {
  return Object.entries(headers ?? {}).map(([key, value]) => ({ key, value }));
}

function toHeaders(rows: HeaderRow[]): Record<string, string> | undefined {
  const next: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0) continue;
    next[key] = row.value;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

const responseRows = ref<HeaderRow[]>(rowsOf(props.draft.config.headers));
const upstreamRows = ref<HeaderRow[]>(
  rowsOf(handler.value.type === 'reverse_proxy' ? handler.value.headers : undefined),
);

watch(
  () => JSON.stringify(props.draft.config.headers ?? {}),
  (serialized) => {
    if (serialized !== JSON.stringify(toHeaders(responseRows.value) ?? {})) {
      responseRows.value = rowsOf(props.draft.config.headers);
    }
  },
);

watch(
  () => JSON.stringify(handler.value.type === 'reverse_proxy' ? (handler.value.headers ?? {}) : {}),
  (serialized) => {
    if (serialized !== JSON.stringify(toHeaders(upstreamRows.value) ?? {})) {
      upstreamRows.value = rowsOf(
        handler.value.type === 'reverse_proxy' ? handler.value.headers : undefined,
      );
    }
  },
);

function commitResponseRows(): void {
  props.draft.config.headers = toHeaders(responseRows.value);
}

function commitUpstreamRows(): void {
  const value = props.draft.config.handler;
  if (value.type === 'reverse_proxy') value.headers = toHeaders(upstreamRows.value);
}

function submit(): void {
  const problem = validateSiteDraft(props.draft);
  if (problem !== null) {
    error.value = problem;
    return;
  }
  error.value = null;
  emit('submit');
}

const indexNamesText = computed({
  get: () => {
    const value = props.draft.config.handler;
    return value.type === 'file_server' ? (value.indexNames ?? []).join(', ') : '';
  },
  set: (raw: string) => {
    const value = props.draft.config.handler;
    if (value.type === 'file_server') value.indexNames = parseCommaList(raw);
  },
});
</script>

<template>
  <div class="site-form">
    <div class="split">
      <div class="main">
        <n-card size="small" title="基础信息">
          <div class="two">
            <n-form-item label="站点名称" required>
              <n-input v-model:value="props.draft.name" placeholder="例如：官网 / blog" />
            </n-form-item>
            <n-form-item label="启用">
              <n-switch v-model:value="props.draft.enabled" />
              <span class="small muted" style="margin-left: 8px">
                {{ props.draft.enabled ? '已启用' : '已禁用（全量应用时从 Caddy 移除）' }}
              </span>
            </n-form-item>
          </div>

          <n-form-item label="域名" required>
            <div class="list">
              <div v-for="(_, index) in props.draft.config.domains" :key="index" class="row">
                <n-input
                  v-model:value="props.draft.config.domains[index]"
                  :placeholder="index === 0 ? 'example.com' : 'www.example.com'"
                />
                <n-button
                  quaternary
                  :disabled="props.draft.config.domains.length <= 1"
                  title="删除域名"
                  @click="removeDomain(index)"
                >
                  <template #icon><n-icon :component="TrashOutline" /></template>
                </n-button>
              </div>
              <n-button
                quaternary
                size="small"
                :disabled="props.draft.config.domains.length >= 50"
                @click="addDomain"
              >
                <template #icon><n-icon :component="AddOutline" /></template>
                添加域名
              </n-button>
            </div>
          </n-form-item>

          <n-form-item label="监听地址（可选）">
            <n-input v-model:value="listenText" placeholder="127.0.0.1:8080" />
          </n-form-item>
        </n-card>

        <n-card size="small" title="处理方式">
          <n-form-item label="类型" required>
            <n-select
              :value="handler.type"
              :options="[
                { value: 'reverse_proxy', label: '反向代理 reverse_proxy' },
                { value: 'file_server', label: '静态文件 file_server' },
                { value: 'redirect', label: '重定向 redirect' },
              ]"
              @update:value="setHandlerType"
            />
          </n-form-item>

          <template v-if="handler.type === 'reverse_proxy'">
            <n-form-item label="上游列表" required>
              <div class="list">
                <div v-for="(_, index) in handler.upstreams" :key="index" class="row">
                  <n-input
                    v-model:value="handler.upstreams[index]"
                    :placeholder="index === 0 ? '127.0.0.1:8080' : '10.0.0.2:3000'"
                  />
                  <n-button
                    quaternary
                    :disabled="handler.upstreams.length <= 1"
                    title="删除上游"
                    @click="removeUpstream(index)"
                  >
                    <template #icon><n-icon :component="TrashOutline" /></template>
                  </n-button>
                </div>
                <n-button quaternary size="small" @click="addUpstream">
                  <template #icon><n-icon :component="AddOutline" /></template>
                  添加上游
                </n-button>
              </div>
            </n-form-item>

            <div class="two">
              <n-form-item label="负载均衡">
                <n-select
                  :value="handler.loadBalance ?? ''"
                  :options="[
                    { value: '', label: '默认（random）' },
                    { value: 'round_robin', label: 'round_robin' },
                    { value: 'random', label: 'random' },
                    { value: 'least_conn', label: 'least_conn' },
                    { value: 'uri_hash', label: 'uri_hash' },
                  ]"
                  @update:value="(value: string) => handler.type === 'reverse_proxy' && (handler.loadBalance = value === '' ? undefined : (value as ReverseProxyHandler['loadBalance']))"
                />
              </n-form-item>
              <n-form-item label="健康检查 URI">
                <n-input
                  :value="handler.healthUri ?? ''"
                  placeholder="/healthz"
                  @update:value="(value: string) => handler.type === 'reverse_proxy' && (handler.healthUri = value.length === 0 ? undefined : value)"
                />
              </n-form-item>
            </div>

            <div class="switch-row">
              <n-switch
                :value="handler.websocket !== false"
                @update:value="(value: boolean) => handler.type === 'reverse_proxy' && (handler.websocket = value)"
              />
              <span class="small">WebSocket 升级</span>
              <n-switch
                :value="handler.tlsSkipVerify === true"
                @update:value="(value: boolean) => handler.type === 'reverse_proxy' && (handler.tlsSkipVerify = value)"
              />
              <span class="small">跳过上游证书校验</span>
            </div>

            <div class="header-editor">
              <div class="header-title small">上游请求头（header_up，可选）</div>
              <div v-for="(row, index) in upstreamRows" :key="index" class="row">
                <n-input v-model:value="row.key" placeholder="Header-Name" class="mono" style="width: 34%" @update:value="commitUpstreamRows" />
                <n-input v-model:value="row.value" placeholder="value" class="mono" @update:value="commitUpstreamRows" />
                <n-button quaternary @click="upstreamRows.splice(index, 1); commitUpstreamRows()">
                  <template #icon><n-icon :component="TrashOutline" /></template>
                </n-button>
              </div>
              <n-button quaternary size="small" @click="upstreamRows.push({ key: '', value: '' })">
                <template #icon><n-icon :component="AddOutline" /></template>
                添加请求头
              </n-button>
            </div>
          </template>

          <template v-if="handler.type === 'file_server'">
            <n-form-item label="根目录" required>
              <n-input
                :value="handler.root"
                placeholder="/var/www/site 或 C:\sites\www"
                @update:value="(value: string) => handler.type === 'file_server' && (handler.root = value)"
              />
            </n-form-item>
            <p class="tiny muted">必须是服务器允许的站点根目录内的绝对路径。</p>
            <div class="two">
              <n-form-item label="索引文件（可选）">
                <n-input v-model:value="indexNamesText" placeholder="index.html, index.htm" />
              </n-form-item>
              <div class="switch-row" style="align-items: center; padding-top: 20px">
                <n-switch
                  :value="handler.spa === true"
                  @update:value="(value: boolean) => handler.type === 'file_server' && (handler.spa = value)"
                />
                <span class="small">SPA 回退</span>
                <n-switch
                  :value="handler.browse === true"
                  @update:value="(value: boolean) => handler.type === 'file_server' && (handler.browse = value)"
                />
                <span class="small">目录浏览</span>
              </div>
            </div>
            <n-form-item label="预压缩文件">
              <div class="switch-row">
                <n-checkbox
                  :checked="(handler.precompressed ?? []).includes('gzip')"
                  @update:checked="(v: boolean) => togglePrecompressed('gzip', v)"
                >
                  gzip
                </n-checkbox>
                <n-checkbox
                  :checked="(handler.precompressed ?? []).includes('zstd')"
                  @update:checked="(v: boolean) => togglePrecompressed('zstd', v)"
                >
                  zstd
                </n-checkbox>
              </div>
            </n-form-item>
          </template>

          <template v-if="handler.type === 'redirect'">
            <n-form-item label="重定向目标" required>
              <n-input
                :value="handler.type === 'redirect' ? handler.to : ''"
                placeholder="https://example.com"
                @update:value="(value: string) => patchRedirect({ to: value })"
              />
            </n-form-item>
            <div class="switch-row">
              <n-switch
                :value="handler.type === 'redirect' ? handler.permanent !== false : true"
                @update:value="(value: boolean) => patchRedirect({ permanent: value })"
              />
              <span class="small">永久重定向（308）</span>
              <n-switch
                :value="handler.type === 'redirect' ? handler.preserveQuery !== false : true"
                @update:value="(value: boolean) => patchRedirect({ preserveQuery: value })"
              />
              <span class="small">保留查询参数</span>
            </div>
          </template>
        </n-card>

        <n-card size="small" title="TLS 与响应">
          <div class="two">
            <n-form-item label="TLS 模式" required>
              <n-select
                v-model:value="tlsMode"
                :options="[
                  { value: 'auto', label: 'auto · 自动申请证书' },
                  { value: 'internal', label: 'internal · Caddy 内部 CA' },
                  { value: 'off', label: 'off · 仅 HTTP' },
                ]"
              />
            </n-form-item>
            <n-form-item v-if="tlsMode === 'auto'" label="ACME 邮箱（可选）">
              <n-input v-model:value="email" placeholder="ops@example.com" />
            </n-form-item>
          </div>

          <div class="header-editor">
            <div class="header-title small">额外响应头</div>
            <div v-for="(row, index) in responseRows" :key="index" class="row">
              <n-input v-model:value="row.key" placeholder="X-Frame-Options" class="mono" style="width: 38%" @update:value="commitResponseRows" />
              <n-input v-model:value="row.value" placeholder="DENY" class="mono" @update:value="commitResponseRows" />
              <n-button quaternary @click="responseRows.splice(index, 1); commitResponseRows()">
                <template #icon><n-icon :component="TrashOutline" /></template>
              </n-button>
            </div>
            <n-button quaternary size="small" @click="responseRows.push({ key: '', value: '' })">
              <template #icon><n-icon :component="AddOutline" /></template>
              添加响应头
            </n-button>
          </div>

          <div class="two" style="margin-top: 10px">
            <n-form-item label="压缩编码">
              <div class="switch-row">
                <n-checkbox
                  :checked="(props.draft.config.encode ?? []).includes('gzip')"
                  @update:checked="(v: boolean) => toggleEncode('gzip', v)"
                >
                  gzip
                </n-checkbox>
                <n-checkbox
                  :checked="(props.draft.config.encode ?? []).includes('zstd')"
                  @update:checked="(v: boolean) => toggleEncode('zstd', v)"
                >
                  zstd
                </n-checkbox>
              </div>
            </n-form-item>
            <div class="switch-row" style="align-items: center; padding-top: 4px">
              <n-switch v-model:value="props.draft.config.log" />
              <span class="small">访问日志</span>
            </div>
          </div>

          <n-alert type="info" :bordered="false" title="基础认证暂不可用">
            契约的 SiteConfig 未定义 basicauth 字段，Caddyfile 生成器无对应指令；为避免静默丢弃，表单不提供该字段。
          </n-alert>
        </n-card>

        <n-alert v-if="error" type="error" :bordered="true" title="无法保存">{{ error }}</n-alert>

        <div class="footer">
          <slot name="footerExtra" />
          <div class="spacer" />
          <n-button v-if="showCancel" quaternary :disabled="submitting" @click="emit('cancel')">取消</n-button>
          <n-button secondary :loading="previewLoading" @click="emit('preview')">预览 Caddyfile</n-button>
          <n-button type="primary" :loading="submitting" @click="submit">{{ submitLabel }}</n-button>
        </div>
      </div>

      <aside v-if="$slots.aside" class="aside">
        <slot name="aside" />
      </aside>
    </div>
  </div>
</template>

<style scoped>
.site-form {
  min-width: 0;
}
.main {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.aside {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.two {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0 12px;
}
@media (max-width: 720px) {
  .two {
    grid-template-columns: 1fr;
  }
}
.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.row > :first-child {
  flex: 1;
}
.switch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.header-editor {
  margin: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.header-title {
  font-weight: 600;
}
.footer {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 4px;
  border-top: 1px solid var(--mpanel-border);
}
.footer .spacer {
  flex: 1;
}
</style>
