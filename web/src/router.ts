import { createRouter, createWebHistory } from 'vue-router';
import { ensureAuth } from './store';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('./views/Login.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      name: 'home',
      component: () => import('./views/Home.vue'),
    },
    {
      path: '/s/:id',
      name: 'chat',
      component: () => import('./views/Chat.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/Settings.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
});

router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  const ok = await ensureAuth();
  if (ok) return true;
  return { path: '/login', query: { redirect: to.fullPath } };
});

export default router;
