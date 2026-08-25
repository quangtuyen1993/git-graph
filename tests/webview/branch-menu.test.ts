import { describe, expect, it } from 'vitest';
import {
  formatBranchFilterLabel,
  formatFilterStatus,
  localNameFor,
  resolvePullTarget,
} from '../../src/webview/lib/branch-menu';

const branch = (over: Partial<Parameters<typeof resolvePullTarget>[0]> = {}) => ({
  name: 'develop', current: false, remote: null, upstream: null, ...over,
});

describe('resolvePullTarget', () => {
  it('splits a remote branch into remote and ref', () => {
    expect(resolvePullTarget(branch({ name: 'origin/bugfix/RMS2025-1027', remote: 'origin' })))
      .toEqual({ remote: 'origin', ref: 'bugfix/RMS2025-1027' });
  });

  it('uses the upstream of a local branch', () => {
    expect(resolvePullTarget(branch({ name: 'develop', upstream: 'origin/develop' })))
      .toEqual({ remote: 'origin', ref: 'develop' });
  });

  it('returns null for a local branch with no upstream', () => {
    expect(resolvePullTarget(branch())).toBeNull();
  });

  it('keeps nested refs intact when splitting', () => {
    expect(resolvePullTarget(branch({ name: 'develop', upstream: 'upstream/team/a/b' })))
      .toEqual({ remote: 'upstream', ref: 'team/a/b' });
  });
});

describe('localNameFor', () => {
  it('strips the remote prefix', () => {
    expect(localNameFor(branch({ name: 'origin/feature/x', remote: 'origin' }))).toBe('feature/x');
  });

  it('leaves a local name alone', () => {
    expect(localNameFor(branch({ name: 'feature/x' }))).toBe('feature/x');
  });
});

describe('formatBranchFilterLabel', () => {
  it('describes the selection', () => {
    expect(formatBranchFilterLabel([])).toBe('All branches');
    expect(formatBranchFilterLabel(['develop'])).toBe('develop');
    expect(formatBranchFilterLabel(['develop', 'main'])).toBe('2 branches');
  });
});

describe('formatFilterStatus', () => {
  it('reports commits against the active filter', () => {
    expect(formatFilterStatus(120, [], 7)).toBe('7 branches, 120 commits');
    expect(formatFilterStatus(30, ['develop'], 7)).toBe('30 commits on develop');
    expect(formatFilterStatus(45, ['develop', 'main'], 7)).toBe('45 commits on 2 branches');
  });
});
