<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import Icon from './components/Icon.vue';
import { authState, toasts } from './store';

const router = useRouter();

function onUnauthorized(): void {
  authState.user = null;
  authState.checked = true;
  const current = router.currentRoute.value;
  if (current.path !== '/login') {
    void router.replace({ path: '/login', query: { redirect: current.fullPath } });
  }
}

onMounted(() => window.addEventListener('cw:unauthorized', onUnauthorized));
onUnmounted(() => window.removeEventListener('cw:unauthorized', onUnauthorized));
</script>

<template>
  <router-view />
  <div class="toast-stack" aria-live="polite">
    <div v-for="item in toasts" :key="item.id" class="toast" :class="item.kind">
      <Icon :name="item.kind === 'error' ? 'alert' : item.kind === 'success' ? 'check' : 'info'" :size="16" />
      <span>{{ item.text }}</span>
    </div>
  </div>
</template>
