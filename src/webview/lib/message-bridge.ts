import type { Request, Response, Event } from '../../extension/types/messages.types';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

type EventHandler = (data: unknown) => void;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const LONG_RUNNING_REQUEST_TIMEOUT_MS = 130_000;
const UNBOUNDED_REQUEST_METHODS = new Set(['graph.build']);
const LONG_RUNNING_REQUEST_METHODS = new Set([
  'git.fetch',
  'git.pull',
  'git.push',
  'git.reword',
  'git.squash',
]);

function requestTimeout(method: string): number | null {
  if (UNBOUNDED_REQUEST_METHODS.has(method)) return null;
  if (LONG_RUNNING_REQUEST_METHODS.has(method)) return LONG_RUNNING_REQUEST_TIMEOUT_MS;
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

export class MessageBridge {
  private vscode: VsCodeApi;
  private pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeoutId?: ReturnType<typeof setTimeout>;
  }>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private requestId = 0;

  constructor() {
    this.vscode = acquireVsCodeApi();

    window.addEventListener('message', (event) => {
      const message = event.data as Response | Event;
      this.handleMessage(message);
    });
  }

  public send(method: string, params?: unknown): Promise<unknown> {
    const id = `req-${++this.requestId}`;
    const request: Request = { id, type: 'request', method, params };

    return new Promise((resolve, reject) => {
      const pending: {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timeoutId?: ReturnType<typeof setTimeout>;
      } = { resolve, reject };
      this.pendingRequests.set(id, pending);
      this.vscode.postMessage(request);

      const timeout = requestTimeout(method);
      if (timeout !== null) {
        pending.timeoutId = setTimeout(() => {
          if (this.pendingRequests.has(id)) {
            this.pendingRequests.delete(id);
            reject(new Error(`Request ${method} timed out`));
          }
        }, timeout);
      }
    });
  }

  public on(event: string, handler: EventHandler): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.eventHandlers.get(event)?.delete(handler);
    };
  }

  private handleMessage(message: Response | Event): void {
    if (message.type === 'response') {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (pending.timeoutId !== undefined) {
          clearTimeout(pending.timeoutId);
        }
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    } else if (message.type === 'event') {
      const handlers = this.eventHandlers.get(message.event);
      if (handlers) {
        handlers.forEach((handler) => handler(message.data));
      }
    }
  }
}

// Singleton instance
export const bridge = new MessageBridge();
