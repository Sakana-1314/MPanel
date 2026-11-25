import { createRoot } from 'react-dom/client';
import App from './app/App';
import { bootstrapConnections } from './lib/bootstrap';
import { getRuntimeConfig, loadRuntimeConfig } from './lib/runtime-config';
import './styles/index.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root element is missing from index.html');
}

// 先读取 /config.json（可失败），再把默认后端写入连接 store，最后渲染。
void loadRuntimeConfig()
  .catch(() => undefined)
  .finally(() => {
    bootstrapConnections(getRuntimeConfig());
    createRoot(container).render(<App />);
  });
