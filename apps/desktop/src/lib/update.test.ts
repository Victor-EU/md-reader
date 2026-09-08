import { describe, expect, it } from 'vitest';
import {
  describeUpdate,
  IDLE,
  reason,
  reportCheck,
  type UpdateState,
  updateAction,
} from './update.ts';

const available: UpdateState = { phase: 'available', update: { version: '0.2.0' } };
const ready: UpdateState = { phase: 'ready', update: { version: '0.2.0' } };

describe('what the status bar stands to say', () => {
  it('says nothing at all until there is an update', () => {
    expect(describeUpdate(IDLE)).toBe('');
    expect(describeUpdate({ phase: 'checking' })).toBe('');
    expect(describeUpdate({ phase: 'none' })).toBe('');
  });

  it('is quiet about a check that failed', () => {
    // An automatic check with no network behind it is the common case,
    // and a reader who did not ask must not be told (plan WP 1.12).
    expect(describeUpdate({ phase: 'failed', message: 'offline' })).toBe('');
  });

  it('names the version it found, and what to do about it', () => {
    expect(describeUpdate(available)).toBe('Version 0.2.0 is available');
    expect(describeUpdate(ready)).toBe('Version 0.2.0 is ready — restart to finish');
  });

  it('counts a download in whole percent, and waits for a length it may never get', () => {
    expect(
      describeUpdate({ phase: 'installing', update: { version: '0.2.0' }, fraction: null }),
    ).toBe('Downloading 0.2.0…');
    expect(
      describeUpdate({ phase: 'installing', update: { version: '0.2.0' }, fraction: 0.417 }),
    ).toBe('Downloading 0.2.0 — 42%');
  });
});

describe('what pressing the cell does', () => {
  it('installs what was found and restarts what was installed', () => {
    expect(updateAction(available)).toBe('install');
    expect(updateAction(ready)).toBe('restart');
  });

  it('offers nothing while there is nothing to offer', () => {
    expect(updateAction(IDLE)).toBeNull();
    expect(updateAction({ phase: 'checking' })).toBeNull();
    expect(updateAction({ phase: 'none' })).toBeNull();
    expect(
      updateAction({ phase: 'installing', update: { version: '0.2.0' }, fraction: 0 }),
    ).toBeNull();
    expect(updateAction({ phase: 'failed', message: 'offline' })).toBeNull();
  });
});

describe('what a check the reader asked for reports', () => {
  it('answers both ways, which is the whole difference from an automatic one', () => {
    expect(reportCheck({ phase: 'checking' })).toBe('Checking for updates…');
    expect(reportCheck({ phase: 'none' })).toBe('MD Reader is up to date');
    expect(reportCheck(available)).toBe('Version 0.2.0 is available');
    expect(reportCheck({ phase: 'failed', message: 'offline' })).toBe(
      'Could not check for updates — offline',
    );
  });
});

describe('a failure, as a sentence', () => {
  it('takes the first line of whatever was thrown', () => {
    expect(reason(new Error('network error\n  at check (…)'))).toBe('network error');
    expect(reason('404 Not Found')).toBe('404 Not Found');
  });

  it('says something rather than nothing when what was thrown is empty', () => {
    expect(reason(new Error(''))).toBe('the check failed');
    expect(reason('   \n')).toBe('the check failed');
  });
});
