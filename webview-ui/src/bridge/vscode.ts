import type { WebviewMessage } from '@shared/messages.js';

// acquireVsCodeApi() can only be called once — cache the instance
const vscodeApi = (() => {
  try {
    return (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (m: unknown) => void } }).acquireVsCodeApi();
  } catch {
    // Running in browser dev mode outside VS Code
    return {
      postMessage: (msg: unknown) => {
        console.log('[vscode bridge mock] →', msg);
      },
    };
  }
})();

export function postMessage(msg: WebviewMessage): void {
  vscodeApi.postMessage(msg);
}
