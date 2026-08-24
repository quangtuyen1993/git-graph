interface EventSender {
  sendEvent(event: string, data?: unknown): void;
}

/**
 * Events like review.changed concern every attached webview (graph and the
 * review tab), not just whichever one happened to be created last. The host
 * broadcasts; each router delivers to its own webview.
 */
export class RouterRegistry {
  private readonly routers = new Set<EventSender>();

  public attach(router: EventSender): () => void {
    this.routers.add(router);
    return () => { this.routers.delete(router); };
  }

  public broadcast(event: string, data?: unknown): void {
    for (const router of this.routers) router.sendEvent(event, data);
  }
}
