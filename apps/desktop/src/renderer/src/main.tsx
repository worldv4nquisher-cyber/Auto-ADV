import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ToastProvider } from './components/ui.tsx';
import { GenesisProvider } from './lib/genesis.tsx';
import { RouterProvider } from './lib/router.tsx';
import { SettingsProvider } from './lib/settings.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root');

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <SettingsProvider>
        <RouterProvider>
          <GenesisProvider>
            <App />
          </GenesisProvider>
        </RouterProvider>
      </SettingsProvider>
    </ToastProvider>
  </StrictMode>,
);
