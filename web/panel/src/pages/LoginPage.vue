<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NAlert, NButton, NIcon, NPopover } from 'naive-ui';
import {
  ChevronDownOutline,
  LockClosedOutline,
  MoonOutline,
  PersonOutline,
  ServerOutline,
  SunnyOutline,
  TrashOutline,
} from '@vicons/ionicons5';
import type { BackendConnection } from '@/api/types';
import { AppError } from '@/api/errors';
import {
  activeConnection,
  addConnection,
  listConnections,
  normalizeBaseUrl,
  removeConnection,
  setActiveConnection,
  touchConnection,
  updateConnection,
} from '@/lib/connection-store';
import { ensureSession, login } from '@/lib/session';
import { queryClient } from '@/lib/query-client';
import { useTheme } from '@/lib/theme';
import FloatingField from '@/components/common/FloatingField.vue';
import LoginTerminal from '@/components/LoginTerminal.vue';
import logoMark from '@/assets/logo-mark.png';

const route = useRoute();
const router = useRouter();
const { isDark, toggle } = useTheme();

const server = ref('');
const username = ref('');
const password = ref('');
const submitting = ref(false);
const loginError = ref<string | null>(null);
const historyOpen = ref(false);

const recentConnections = computed(() => listConnections());
const year = new Date().getFullYear();

const redirectTarget = computed(() => {
  const redirect = route.query.redirect;
  if (typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('/login')) {
    return redirect;
  }
  return '/';
});

onMounted(() => {
  const current = activeConnection.value ?? listConnections()[0];
  server.value = current?.baseUrl ?? window.location.origin;
  username.value = current?.username ?? '';
  password.value = '';
  // 没有连接时把会话状态从初始 checking 归位到 no-connection。
  void ensureSession();
});

/** 允许用户只填 host（自动沿用当前页面的协议），也接受完整 URL。 */
function normalizeServer(raw: string): string {
  let value = raw.trim().replace(/\/+$/, '');
  if (value.length === 0) return '';
  if (!/^https?:\/\//i.test(value)) {
    const scheme = window.location.protocol === 'https:' ? 'https://' : 'http://';
    value = scheme + value;
  }
  return normalizeBaseUrl(value);
}

function serverHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function serverName(url: string): string {
  return serverHost(url);
}

function syncUsernameFromServer(): void {
  const saved = listConnections().find((item) => item.baseUrl === normalizeServer(server.value));
  if (saved?.username !== undefined && saved.username.length > 0) {
    username.value = saved.username;
  }
}

function selectRecent(item: BackendConnection): void {
  server.value = item.baseUrl;
  username.value = item.username ?? '';
  password.value = '';
  loginError.value = null;
  historyOpen.value = false;
}

function forgetRecent(item: BackendConnection): void {
  removeConnection(item.id);
  if (normalizeServer(server.value) === item.baseUrl) {
    const next = listConnections()[0];
    server.value = next?.baseUrl ?? window.location.origin;
    username.value = next?.username ?? '';
    password.value = '';
  }
}

function loginErrorFor(error: unknown): string {
  if (!(error instanceof AppError)) return '登录失败，请稍后重试';
  switch (error.code) {
    case 'UNAUTHORIZED':
      return error.detail?.retryAfterSec !== undefined ? error.message : '用户名或密码错误';
    case 'NOT_FOUND':
    case 'INTERNAL':
      return '服务器地址不正确';
    case 'NETWORK':
      return '无法连接服务器';
    case 'TIMEOUT':
      return '连接超时';
    case 'UNAVAILABLE':
      return '服务暂时不可用';
    case 'BAD_REQUEST':
      return error.message.length > 0 ? error.message : '请检查输入';
    default:
      return '登录失败，请稍后重试';
  }
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  loginError.value = null;

  const normalized = normalizeServer(server.value);
  if (normalized.length === 0) {
    loginError.value = '请填写服务器地址';
    return;
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('protocol');
    }
  } catch {
    loginError.value = '服务器地址格式不正确';
    return;
  }
  if (username.value.trim().length === 0) {
    loginError.value = '请填写用户名';
    return;
  }
  if (password.value.length === 0) {
    loginError.value = '请填写密码';
    return;
  }

  submitting.value = true;
  let createdId: string | null = null;
  try {
    const existing = listConnections().find((item) => item.baseUrl === normalized);
    let connection = existing;
    if (connection === undefined) {
      connection = addConnection({ name: serverName(normalized), baseUrl: normalized });
      createdId = connection.id;
    }
    setActiveConnection(connection.id);
    // 让全局连接切换 watch 先清理旧会话/标签，再提交登录。
    await nextTick();
    await login(username.value.trim(), password.value);
    updateConnection(connection.id, { username: username.value.trim() });
    touchConnection(connection.id);
    queryClient.clear();
    await router.replace(redirectTarget.value);
  } catch (error) {
    // 只记录真正登录成功的服务器；失败的新地址不写入最近登录。
    if (createdId !== null) removeConnection(createdId);
    loginError.value = loginErrorFor(error);
  } finally {
    submitting.value = false;
  }
}

const canSubmit = computed(
  () =>
    server.value.trim().length > 0 &&
    username.value.trim().length > 0 &&
    password.value.length > 0 &&
    !submitting.value,
);
</script>

<template>
  <div class="login-page">
    <aside class="brand-panel">
      <div class="brand-top">
        <span class="brand-mark"><img :src="logoMark" alt="MPanel" /></span>
        <span class="brand-name">MPanel</span>
      </div>

      <div class="brand-main">
        <div class="brand-copy">
          <p class="eyebrow">MPANEL · SERVER CONSOLE</p>
          <h1>
            一处登录，<br />
            <span class="accent">管理所有服务器。</span>
          </h1>
          <p class="lede">把重复的运维收进同一个工作台，把注意力留给真正重要的事。</p>

          <ul class="features">
            <li>
              <span class="feature-icon"><n-icon :component="ServerOutline" /></span>
              <span>
                <strong>统一入口</strong>
                <small>站点、容器、数据库、文件与终端都在一个面板。</small>
              </span>
            </li>
            <li>
              <span class="feature-icon"><n-icon :component="PersonOutline" /></span>
              <span>
                <strong>多机协作</strong>
                <small>标签页绑定机器，同时处理多台服务器。</small>
              </span>
            </li>
            <li>
              <span class="feature-icon"><n-icon :component="LockClosedOutline" /></span>
              <span>
                <strong>安全访问</strong>
                <small>统一登录与权限校验，危险操作确认后才执行。</small>
              </span>
            </li>
          </ul>
        </div>

        <login-terminal />
      </div>

      <p class="brand-foot">© {{ year }} MPanel</p>
    </aside>

    <main class="form-panel">
      <button type="button" class="theme-toggle" :title="isDark ? '浅色主题' : '深色主题'" @click="toggle">
        <n-icon :component="isDark ? SunnyOutline : MoonOutline" />
      </button>

      <div class="form-wrap">
        <div class="mobile-brand">
          <span class="brand-mark"><img :src="logoMark" alt="MPanel" /></span>
          <span class="brand-name">MPanel</span>
        </div>

        <div class="login-card">
          <p class="eyebrow">MPANEL CONSOLE</p>
          <h2>登录面板</h2>

          <div class="fields">
            <floating-field
              v-model="server"
              label="服务器"
              autocomplete="url"
              @blur="syncUsernameFromServer"
              @keydown.enter="submit"
            >
              <template #prefix><n-icon :component="ServerOutline" /></template>
              <template #suffix>
                <n-popover
                  v-model:show="historyOpen"
                  trigger="click"
                  placement="bottom-end"
                  raw
                  :duration="0"
                  :show-arrow="false"
                >
                  <template #trigger>
                    <button
                      type="button"
                      class="history-trigger"
                      :class="{ open: historyOpen }"
                      title="最近登录"
                    >
                      <n-icon :component="ChevronDownOutline" />
                    </button>
                  </template>
                  <div class="history-panel">
                    <div class="history-head">最近登录</div>
                    <div v-if="recentConnections.length === 0" class="history-empty">暂无记录</div>
                    <div v-else class="history-list">
                      <div
                        v-for="item in recentConnections"
                        :key="item.id"
                        class="history-row"
                        role="button"
                        tabindex="0"
                        @click="selectRecent(item)"
                        @keydown.enter="selectRecent(item)"
                      >
                        <span class="history-main">
                          <span class="history-host truncate">{{ serverHost(item.baseUrl) }}</span>
                          <span class="history-user truncate">{{ item.username ?? '未保存账号' }}</span>
                        </span>
                        <button
                          type="button"
                          class="history-delete"
                          title="删除记录"
                          @click.stop="forgetRecent(item)"
                        >
                          <n-icon :component="TrashOutline" />
                        </button>
                      </div>
                    </div>
                  </div>
                </n-popover>
              </template>
            </floating-field>

            <floating-field
              v-model="username"
              label="用户名"
              autocomplete="username"
              @keydown.enter="submit"
            >
              <template #prefix><n-icon :component="PersonOutline" /></template>
            </floating-field>

            <floating-field
              v-model="password"
              label="密码"
              type="password"
              show-password-on="click"
              autocomplete="current-password"
              @keydown.enter="submit"
            >
              <template #prefix><n-icon :component="LockClosedOutline" /></template>
            </floating-field>
          </div>

          <n-button
            type="primary"
            size="large"
            block
            :loading="submitting"
            :disabled="!canSubmit"
            @click="submit"
          >
            登录
          </n-button>

          <n-alert
            v-if="loginError"
            class="login-error"
            type="error"
            :bordered="false"
            show-icon
          >
            {{ loginError }}
          </n-alert>
        </div>

        <p class="form-foot">MPanel · 服务器管理面板</p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(0, 46%) minmax(0, 54%);
  background: var(--mpanel-bg);
}

/* ------------------------------- left panel ------------------------------- */

.brand-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 32px;
  padding: 44px 52px;
  overflow-x: hidden;
  overflow-y: auto;
  color: #e6edf3;
  background:
    radial-gradient(720px 420px at 18% 8%, rgb(47 129 247 / 22%), transparent 62%),
    linear-gradient(160deg, #0b1220 0%, #0d1117 58%, #090e17 100%);
}
.brand-panel::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgb(255 255 255 / 3.5%) 1px, transparent 1px),
    linear-gradient(90deg, rgb(255 255 255 / 3.5%) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: linear-gradient(to bottom, rgb(0 0 0 / 85%), transparent 88%);
  pointer-events: none;
}
.brand-panel > * {
  position: relative;
  z-index: 1;
}
.brand-top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.brand-mark {
  display: grid;
  place-items: center;
  width: 56px;
  height: 40px;
  padding: 3px 6px;
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 1px 2px rgb(0 0 0 / 18%);
  flex: 0 0 auto;
}
.brand-mark img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.brand-name {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: 0.02em;
}
.brand-main {
  display: flex;
  flex-direction: column;
  gap: 30px;
  max-width: 520px;
}
.eyebrow {
  margin: 0 0 14px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: #79c0ff;
}
.brand-copy h1 {
  margin: 0;
  font-size: clamp(30px, 3vw, 40px);
  line-height: 1.16;
  letter-spacing: -0.02em;
  color: #f0f6fc;
}
.brand-copy h1 .accent {
  background: linear-gradient(90deg, #79c0ff 0%, #a5d6ff 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.lede {
  margin: 14px 0 0;
  max-width: 440px;
  font-size: 13.5px;
  line-height: 1.7;
  color: rgb(230 237 243 / 62%);
}
.features {
  list-style: none;
  margin: 28px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.features li {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}
.feature-icon {
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 10px;
  border: 1px solid rgb(255 255 255 / 8%);
  background: rgb(255 255 255 / 5%);
  color: #79c0ff;
  font-size: 16px;
}
.features strong {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: #e6edf3;
}
.features small {
  display: block;
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.55;
  color: rgb(230 237 243 / 52%);
}
.brand-foot {
  margin: 0;
  font-size: 11px;
  color: rgb(230 237 243 / 32%);
}

/* ------------------------------- right panel ------------------------------ */

.form-panel {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  background:
    radial-gradient(680px 420px at 82% 12%, color-mix(in srgb, var(--mpanel-accent) 7%, transparent), transparent 65%),
    var(--mpanel-bg);
}
.theme-toggle {
  position: absolute;
  top: 20px;
  right: 20px;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--mpanel-border);
  border-radius: 9px;
  background: var(--mpanel-surface);
  color: var(--mpanel-muted);
  cursor: pointer;
  font-size: 16px;
}
.theme-toggle:hover {
  color: var(--mpanel-text);
}
.form-wrap {
  width: 100%;
  max-width: 400px;
}
.mobile-brand {
  display: none;
  align-items: center;
  gap: 10px;
  margin-bottom: 20px;
}
.login-card {
  padding: 32px 30px 30px;
  border: 1px solid var(--mpanel-border);
  border-radius: 16px;
  background: var(--mpanel-surface);
  box-shadow: 0 18px 50px rgb(1 4 9 / 8%);
}
html.dark .login-card {
  box-shadow: 0 18px 50px rgb(0 0 0 / 36%);
}
.login-card .eyebrow {
  display: inline-block;
  margin: 0 0 12px;
  padding: 4px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--mpanel-accent) 12%, transparent);
  color: var(--mpanel-accent);
  letter-spacing: 0.16em;
}
.login-card h2 {
  margin: 0 0 22px;
  font-size: 24px;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: var(--mpanel-text);
}
.fields {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.login-card :deep(.n-button) {
  margin-top: 22px;
}
.login-error {
  margin-top: 14px;
  border-radius: 10px;
  font-size: 12.5px;
}
.history-trigger {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--mpanel-muted);
  cursor: pointer;
  transition: transform 0.16s ease, color 0.16s ease;
}
.history-trigger:hover {
  color: var(--mpanel-text);
}
.history-trigger.open {
  transform: rotate(180deg);
}
.history-panel {
  width: 300px;
  padding: 6px;
  border: 1px solid var(--mpanel-border);
  border-radius: 12px;
  background: var(--mpanel-surface);
  box-shadow: 0 16px 36px rgb(1 4 9 / 14%);
}
html.dark .history-panel {
  box-shadow: 0 16px 36px rgb(0 0 0 / 42%);
}
.history-head {
  padding: 6px 10px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--mpanel-muted);
}
.history-empty {
  padding: 18px 10px;
  text-align: center;
  font-size: 12px;
  color: var(--mpanel-muted);
}
.history-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.history-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  outline: none;
}
.history-row:hover,
.history-row:focus-visible {
  background: var(--mpanel-surface-soft);
}
.history-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  line-height: 1.35;
}
.history-host {
  font-size: 12.5px;
  color: var(--mpanel-text);
}
.history-user {
  font-size: 11px;
  color: var(--mpanel-muted);
}
.history-delete {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--mpanel-muted);
  cursor: pointer;
}
.history-delete:hover {
  background: color-mix(in srgb, var(--mpanel-danger, #cf222e) 12%, transparent);
  color: var(--mpanel-danger, #cf222e);
}
.form-foot {
  margin: 18px 0 0;
  text-align: center;
  font-size: 11px;
  color: var(--mpanel-muted);
}

@media (max-width: 960px) {
  .login-page {
    grid-template-columns: minmax(0, 1fr);
  }
  .brand-panel {
    display: none;
  }
  .mobile-brand {
    display: flex;
  }
  .mobile-brand .brand-mark {
    width: 46px;
    height: 34px;
    padding: 2px 5px;
  }
  .form-panel {
    padding: 32px 18px;
  }
  .login-card {
    padding: 26px 22px 24px;
  }
}
</style>
