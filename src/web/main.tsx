import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthGate } from './auth/Login';
import { installCapture } from './capture/capture-app';
import { parseFileRoute } from './router';
import './styles.css';
import { initTheme } from './theme';

const container = document.getElementById('root')!;
const params = new URLSearchParams(location.search);

function loadFonts() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/fonts/fonts.css';
  document.head.appendChild(link);
}

loadFonts();

const runtimeModules = import.meta.glob('./runtime/runtime-app.tsx');

if (params.get('capture') === '1') {
  document.body.classList.add('moki-capture');
  installCapture(container);
} else if (params.get('runtime') === '1') {
  document.body.classList.add('moki-runtime');
  const route = parseFileRoute(location.pathname);
  const loader = runtimeModules['./runtime/runtime-app.tsx'];
  if (route && loader) {
    loader().then((m) => (m as { mountRuntime: (el: HTMLElement, fileId: string) => void }).mountRuntime(container, route.fileId));
  } else {
    container.textContent = 'Moki runtime: ruta o módulo no disponible';
  }
} else {
  initTheme(); // solo la interfaz del editor: runtime y capturas pintan siempre igual
  createRoot(container).render(
    <AuthGate>
      <App />
    </AuthGate>,
  );
}
