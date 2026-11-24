<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { t } from '../i18n';
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
          {{ t('计划待确认') }}
          <span class="permission-tool">ExitPlanMode</span>
        </div>
        <p class="permission-desc">{{ t('Claude 已完成规划，批准后才会离开计划模式并开始执行。') }}</p>
      </div>
      <span class="permission-wait">{{ t('任务已暂停') }}</span>
    </div>

    <div class="plan-body markdown" v-html="rendered" />

    <label class="field plan-feedback">
      <span>{{ t('修改意见（拒绝时带给 Claude）') }}</span>
      <input
        v-model="feedback"
        :placeholder="t('例如：先补测试，再执行…')"
        :disabled="busy"
      />
    </label>

    <div class="permission-foot">
      <p class="permission-note">
        {{ t('批准会开始执行；拒绝会保留计划模式。超时 {n} 分钟按拒绝处理。', { n: timeoutMinutes ?? 30 }) }}
      </p>
      <div class="permission-actions">
        <button class="btn secondary" :disabled="busy" @click="decide(false)">{{ t('继续完善计划') }}</button>
        <button class="btn primary" :disabled="busy" @click="decide(true)">
          {{ busy ? t('处理中…') : t('批准并开始执行') }}
        </button>
      </div>
    </div>
  </section>
</template>
