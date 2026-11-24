declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

declare module 'ansi-to-html' {
  export default class AnsiToHtml {
    constructor(options?: {
      fg?: string;
      bg?: string;
      newline?: boolean;
      escapeXML?: boolean;
      stream?: boolean;
      colors?: Record<number, string>;
    });
    toHtml(input: string): string;
  }
}
