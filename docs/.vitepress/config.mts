import { defineConfig } from 'vitepress';

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Syn: real-time shared state for hApps',
  description: 'Documentation for the syn holochain engine',
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Introduction', link: '/welcome-to-syn' },
      { text: 'Guides', link: '/guides/setup' },
      { text: 'API', link: '/api/syn-store' },
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Welcome to Syn', link: '/welcome-to-syn' },
          { text: 'Quickstart', link: '/quickstart' },
          { text: 'Design', link: '/design' },
          { text: 'Automerge memory model', link: '/automerge-memory' },
        ],
      },
      {
        text: 'Guides',
        items: [
          {
            text: 'Getting ready to build a syn hApp',
            link: '/guides/setup',
          },
          {
            text: 'Building a simple kanban board app',
            link: '/guides/building-a-simple-kanban-board-app',
          },
          {
            text: 'Building an app with ephemeral state',
            link: '/guides/building-an-ephemeral-state-app',
          },
          {
            text: 'Building an app with text editors',
            link: '/guides/building-app-with-text-editors',
          },
        ],
      },
      {
        text: 'API Reference',
        items: [{ text: 'SynStore', link: '/api/syn-store' }],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/holochain-apps/syn' },
    ],
    search: {
      provider: 'local',
    },
  },
  base: '/syn/', // URL is https://holochain-apps.github.io/syn
});
