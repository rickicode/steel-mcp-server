import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSteelMode } from '../dist/steelMode.js';

test('defaults local Steel base URL to localhost:3000 when env is unset', () => {
  assert.deepEqual(resolveSteelMode(undefined, undefined), {
    steelLocal: true,
    steelBaseURL: 'http://localhost:3000',
  });
});
