import * as vscode from 'vscode';
import type { Request, Response, Event } from '../types/messages.types';
import type { WebviewHost } from '../types/webview-host.types';

export type MethodHandler = (method: string, params: unknown) => Promise<unknown>;

export class MessageRouter {
  private handlers = new Map<string, MethodHandler>();
  private host: WebviewHost | undefined;
  private receiveSubscription: vscode.Disposable | undefined;

  public setHost(host: WebviewHost): void {
    this.receiveSubscription?.dispose();
    this.host = host;

    this.receiveSubscription = host.webview.onDidReceiveMessage((message: Request) => {
      if (message.type === 'request') {
        this.handleMessage(message);
      }
    });
  }

  public register(namespace: string, handler: MethodHandler): void {
    this.handlers.set(namespace, handler);
  }

  public sendEvent(event: string, data?: unknown): void {
    if (this.host) {
      const msg: Event = { type: 'event', event, data };
      this.host.webview.postMessage(msg);
    }
  }

  public dispose(): void {
    this.receiveSubscription?.dispose();
    this.receiveSubscription = undefined;
    this.handlers.clear();
    this.host = undefined;
  }

  private async handleMessage(request: Request): Promise<void> {
    const [namespace] = request.method.split('.');

    const handler = this.handlers.get(namespace);

    let response: Response;
    if (!handler) {
      response = {
        id: request.id,
        type: 'response',
        error: { code: -1, message: `No handler for namespace: ${namespace}` }
      };
    } else {
      try {
        const result = await handler(request.method, request.params);
        response = { id: request.id, type: 'response', result };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        response = {
          id: request.id,
          type: 'response',
          error: { code: -1, message: errorMessage }
        };
      }
    }

    this.host?.webview.postMessage(response);
  }
}
