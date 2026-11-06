import { createRoot } from 'react-dom/client';
import App from './App';
import { initializeBridge } from './bridge';
void initializeBridge().then(() => createRoot(document.getElementById('root')!).render(<App />)).catch(error => {
  const root = document.getElementById('root')!;
  root.style.cssText = 'padding:40px;font:14px Segoe UI,sans-serif;white-space:pre-wrap';
  root.textContent = `Pi Desktop 启动失败\n\n${String(error)}`;
});
