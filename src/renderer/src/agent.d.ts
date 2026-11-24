// Type declaration for the preload bridge (window.agent).
import type { AgentApi } from '../../preload/preload.js';

declare global {
  interface Window {
    agent: AgentApi;
  }
}

export {};
