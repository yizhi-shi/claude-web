<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PendingPlanView } from '../types';
import { renderMarkdown } from '../utils';
import Icon from './Icon.vue';

const props = defineProps<{
  plan: PendingPlanView;
  busy?: boolean;
  timeoutMinutes?: number;
}>();

const emit = defineEmits<{
  decide: [approved: boolean, feedback?: string];
}>();

const feedback = ref('');
const rendered = computed(() => renderMarkdown(props.plan.plan));

watch(
  () => props.plan.requestId,
  () => {
    feedback.value = '';
  },
);

function decide(approved: boolean): void {
  if (props.busy) return;
  emit('decide', approved, approved ? undefined : feedback.value.trim());
}
</script>

<template>
  <section class="permission-panel plan-panel">
    <div class="permission-head">
      <span class="permission-icon plan-icon"><Icon name="list" :size="18" /></span>
      <div class="permission-copy">
        <div class="permission-title">
          计划待确认
          <span class="permission-tool">ExitPlanMode</span>
        </div>
        <p class="permission-desc">Claude 已完成规划，批准后才会离开计划模式并开始执行。</p>
      </div>
      <span class="permission-wait">任务已暂停</span>
    </div>

    <div class="plan-body markdown" v-html="rendered" />

    <label class="field plan-feedback">
      <span>修改意见（拒绝时带给 Claude）</span>
      <input
        v-model="feedback"
        placeholder="例如：先补测试，再执行…"
        :disabled="busy"
      />
    </label>

    <div class="permission-foot">
      <p class="permission-note">
        批准会开始执行；拒绝会保留计划模式。超时 {{ timeoutMinutes ?? 30 }} 分钟按拒绝处理。
      </p>
      <div class="permission-actions">
        <button class="btn secondary" :disabled="busy" @click="decide(false)">继续完善计划</button>
        <button class="btn primary" :disabled="busy" @click="decide(true)">
          {{ busy ? '处理中…' : '批准并开始执行' }}
        </button>
      </div>
    </div>
  </section>
</template>
