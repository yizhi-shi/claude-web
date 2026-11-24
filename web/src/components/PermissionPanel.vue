<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { t } from '../i18n';
import type { PendingPermissionView } from '../types';
import { presentTool } from '../utils';
import Icon from './Icon.vue';

const props = defineProps<{
  permission: PendingPermissionView;
  busy?: boolean;
  timeoutMinutes?: number;
}>();

const emit = defineEmits<{
  respond: [decision: 'allow_once' | 'allow_session' | 'deny'];
}>();

const presentation = computed(() => presentTool(props.permission.toolName, props.permission.input));
const diffLines = computed(() => presentation.value.diff?.slice(0, 200) ?? []);
const denyRef = ref<HTMLButtonElement | null>(null);

const command = computed(() => presentation.value.command ?? '');
const detailTitle = computed(
  () =>
    props.permission.title ||
    props.permission.description ||
    t('{tool} 请求执行', { tool: props.permission.toolName }),
);
const canAlwaysAllow = computed(() => !props.permission.suppressAlwaysAllowRule);

onMounted(async () => {
  if (props.permission.defaultToNo) {
    await nextTick();
    denyRef.value?.focus();
  }
});
</script>

<template>
  <section class="permission-panel" :class="{ 'default-no': permission.defaultToNo }">
    <div class="permission-head">
      <span class="permission-icon"><Icon name="shield" :size="18" /></span>
      <div class="permission-copy">
        <div class="permission-title">
          {{ t('需要你的批准') }}
          <span class="permission-tool">{{ permission.toolName }}</span>
        </div>
        <p class="permission-desc">{{ detailTitle }}</p>
      </div>
      <span class="permission-wait">{{ t('任务已暂停') }}</span>
    </div>

    <div v-if="command" class="permission-command">
      <span class="command-prompt">$</span>
      <pre>{{ command }}</pre>
    </div>

    <div v-else-if="diffLines.length" class="diff-view permission-diff">
      <div v-for="(line, index) in diffLines" :key="index" class="diff-line" :class="line.kind">
        <span class="diff-sign">{{ line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ' }}</span>
        <span class="diff-text">{{ line.text }}</span>
      </div>
    </div>

    <pre v-else class="permission-json">{{ JSON.stringify(permission.input, null, 2) }}</pre>

    <div class="permission-foot">
      <p class="permission-note">
        {{ t('仅批准你确认过的操作。超时 {n} 分钟将自动拒绝。', { n: timeoutMinutes ?? 30 }) }}
      </p>
      <div class="permission-actions">
        <button ref="denyRef" class="btn ghost danger-text" :disabled="busy" @click="emit('respond', 'deny')">
          {{ t('拒绝') }}
        </button>
        <button class="btn secondary" :disabled="busy" @click="emit('respond', 'allow_once')">
          {{ t('允许一次') }}
        </button>
        <button
          v-if="canAlwaysAllow"
          class="btn primary"
          :disabled="busy"
          @click="emit('respond', 'allow_session')"
        >
          {{ t('本次会话允许') }}
        </button>
      </div>
    </div>
  </section>
</template>
