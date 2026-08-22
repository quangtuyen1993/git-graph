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
  error?: { code: number; message: string };
}

export interface Event {
  type: 'event';
  event: string;
  data?: unknown;
}

export type Message = Request | Response | Event;
