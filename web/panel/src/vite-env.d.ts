/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_BACKEND?: string;
  readonly VITE_DEFAULT_BACKEND_NAME?: string;
  readonly VITE_DEFAULT_BACKEND_LABEL?: string;
  readonly VITE_DEFAULT_BACKEND_TOKEN?: string;
  readonly VITE_DEFAULT_BACKEND_KIND?: 'worker' | 'core';
  readonly VITE_DEFAULT_BACKENDS?: string;
  readonly VITE_DBX_URL?: string;
  readonly VITE_API_TIMEOUT_MS?: string;
  readonly VITE_BASE_PATH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
