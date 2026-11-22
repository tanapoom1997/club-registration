import { describe, expect, it } from 'vitest';
import { ERROR_CODES, errorResponseSchema } from '../src/error.js';

// The web app branches on these codes (never on message text), so each must stay one distinct
// string the API and the web agree on.
describe('error codes', () => {
  it('names the queue gate with its own code', () => {
    expect(ERROR_CODES.queueRequired).toBe('queue_required');
  });

  // The queue's join and heartbeat in a round without a queue (README Phase 3 decision 6).
  it('names a round without a queue with its own code', () => {
    expect(ERROR_CODES.queueOff).toBe('queue_off');
  });

  it('gives every code a distinct value', () => {
    const codes = Object.values(ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
  });

  it('parses a queue_required answer like any other error', () => {
    const body = { code: ERROR_CODES.queueRequired, message: 'wait for your turn' };
    expect(errorResponseSchema.parse(body)).toEqual(body);
  });
});
