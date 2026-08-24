import { describe, expect, it, vi } from 'vitest';
import { RouterRegistry } from '../../src/extension/controllers/router-registry';

describe('RouterRegistry', () => {
  it('broadcasts to every attached router', () => {
    const registry = new RouterRegistry();
    const a = { sendEvent: vi.fn() };
    const b = { sendEvent: vi.fn() };
    registry.attach(a);
    registry.attach(b);

    registry.broadcast('review.changed', { id: 'x' });

    expect(a.sendEvent).toHaveBeenCalledWith('review.changed', { id: 'x' });
    expect(b.sendEvent).toHaveBeenCalledWith('review.changed', { id: 'x' });
  });

  it('stops sending to a detached router', () => {
    const registry = new RouterRegistry();
    const a = { sendEvent: vi.fn() };
    const detach = registry.attach(a);
    detach();

    registry.broadcast('review.changed');

    expect(a.sendEvent).not.toHaveBeenCalled();
  });

  it('detaching twice is harmless', () => {
    const registry = new RouterRegistry();
    const detach = registry.attach({ sendEvent: vi.fn() });
    detach();
    expect(() => detach()).not.toThrow();
  });
});
