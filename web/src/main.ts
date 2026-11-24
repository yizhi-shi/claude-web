import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import { initTheme, type ThemeMode } from './store';
import './styles.css';

async function boot(): Promise<void> {
  let mode: ThemeMode = 'system';
  try {
    const response = await fetch('/api/auth/status', { credentials: 'same-origin' });
    if (response.ok) {
      const status = (await response.json()) as { defaultTheme?: ThemeMode };
      if (status.defaultTheme) mode = status.defaultTheme;
    }
  } catch {
    // offline or service starting; the system preference is a safe fallback
  }
  initTheme(mode);
  createApp(App).use(router).mount('#app');
}

void boot();
