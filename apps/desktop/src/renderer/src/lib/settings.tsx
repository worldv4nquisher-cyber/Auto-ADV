import type { SettingsView } from '@auto-adv/engine/api';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { engine, errorMessage, onConnectionChange } from './engine.ts';

interface SettingsState {
  settings: SettingsView | null;
  error: string | null;
  refresh: () => Promise<void>;
}

const SettingsContext = createContext<SettingsState>({ settings: null, error: null, refresh: async () => {} });

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setSettings(await engine.call('getSettings'));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    void refresh();
    return onConnectionChange((connected) => {
      if (connected) void refresh();
    });
  }, [refresh]);
  return <SettingsContext.Provider value={{ settings, error, refresh }}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  return useContext(SettingsContext);
}
