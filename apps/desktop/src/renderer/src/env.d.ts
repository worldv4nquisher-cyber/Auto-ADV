/// <reference types="vite/client" />
import type { AutoAdvBridge } from '../../preload/index.ts';

declare global {
  interface Window {
    autoAdv: AutoAdvBridge;
  }
}
