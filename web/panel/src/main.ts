import { createApp } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { watch } from 'vue';
import App from './App.vue';
import { router } from './router';
import { queryClient } from './lib/query-client';
import { loadRuntimeConfig } from './lib/runtime-config';
import { bootstrapConnections } from './lib/bootstrap';
import { restoreWorkspace, resetWorkspace } from './lib/workspace';
import { activeConnectionId } from './lib/connection-store';
import { resetSession } from './lib/session';
import { closeAllWs } from './api/ws';
import './styles/index.css';

async function start(): Promise<void> {
  try {
    await loadRuntimeConfig();
  } catch {
    // 没有 config.json 是正常部署形态。
  }
  bootstrapConnections();
  restoreWorkspace(activeConnectionId.value);

  const app = createApp(App);
  app.use(VueQueryPlugin, { queryClient });
  app.use(router);
  app.mount('#app');

  watch(activeConnectionId, (next, previous) => {
    if (next === previous) return;
    resetSession();
    resetWorkspace(next);
    queryClient.clear();
    closeAllWs();
    if (router.currentRoute.value.meta.public !== true) {
      void router.replace('/');
    }
  });
}

void start();
