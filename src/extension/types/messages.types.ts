export interface Request {
  id: string;
  type: 'request';
  method: string;
  params?: unknown;
}

export interface Response {
  id: string;
  type: 'response';
  result?: unknown;
  /**
   * `kind` is a stable discriminator for failures the UI must react to.
   * `data` carries structured payload alongside a failure that needs more
   * than a message and a kind to act on — e.g. `forge.pr.create`'s
   * duplicate error, which names the existing pull request so the caller
   * can offer to open it.
   */
  error?: { code: number; message: string; kind?: string; data?: unknown };
}

export interface Event {
  type: 'event';
  event: string;
  data?: unknown;
}

export type Message = Request | Response | Event;
