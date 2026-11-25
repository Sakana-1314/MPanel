<script setup lang="ts">
import { useRouter } from 'vue-router';
import { NButton, NEmpty, NIcon } from 'naive-ui';
import { HomeOutline } from '@vicons/ionicons5';

const router = useRouter();
</script>

<template>
  <div class="not-found">
    <n-empty description="页面不存在">
      <template #extra>
        <n-button type="primary" @click="router.replace('/')">
          <template #icon><n-icon :component="HomeOutline" /></template>
          返回工作台
        </n-button>
      </template>
    </n-empty>
  </div>
</template>

<style scoped>
.not-found {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--mpanel-bg);
}
</style>
