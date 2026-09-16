import type { DarkWhisperApi } from '../shared/api.js';

// marked and DOMPurify are loaded as classic scripts by public/index.html (UMD globals).
declare global {
  interface Window {
    api: DarkWhisperApi;
  }
  const marked: {
    parse(markdown: string, options?: { async?: false; gfm?: boolean; breaks?: boolean }): string;
  };
  const DOMPurify: {
    sanitize(dirty: string, config?: Record<string, unknown>): string;
  };
}

export {};
