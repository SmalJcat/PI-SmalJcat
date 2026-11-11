import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  base: './',
  // 多页面：主窗口 index.html，沙箱 widget 窗口 widget-sandbox.html（独立 WebView，自带 CSP 与权限集）。
  build: { rollupOptions: { input: { index: 'index.html', widget: 'widget-sandbox.html', review: 'review-window.html' } } },
  clearScreen: false,
  server: { host: '127.0.0.1', port: 5178, strictPort: true, watch: { ignored: ['**/src-tauri/**', '**/release/**', '**/artifacts/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
});
