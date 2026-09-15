jest.mock('axios', () => {
  const create = jest.fn(() => ({ get: jest.fn(), post: jest.fn() }));
  return { __esModule: true, default: { create }, create };
});

import axios from 'axios';
import { setApiConfig, BUILTIN_TIMEOUT_MS, EXTERNAL_TIMEOUT_MS } from '../services/apiService';

const create = axios.create as unknown as jest.Mock;
const lastConfig = () => create.mock.calls[create.mock.calls.length - 1][0];

describe('apiService configuration', () => {
  it('uses the external defaults on load', () => {
    expect(create).toHaveBeenCalledTimes(1);
    expect(lastConfig()).toMatchObject({ baseURL: 'http://127.0.0.1:4444', timeout: EXTERNAL_TIMEOUT_MS });
  });

  it('applies the built-in server url and 5 minute timeout without auth', () => {
    setApiConfig('http://127.0.0.1:5000', '', { timeoutMs: BUILTIN_TIMEOUT_MS });
    expect(BUILTIN_TIMEOUT_MS).toBe(300_000);
    expect(lastConfig()).toMatchObject({ baseURL: 'http://127.0.0.1:5000', timeout: 300_000 });
    expect(lastConfig().headers.Authorization).toBeUndefined();
  });

  it('keeps bearer auth and the 30 second timeout for external APIs', () => {
    setApiConfig('https://api.example.com', 'sk-test');
    expect(lastConfig()).toMatchObject({ baseURL: 'https://api.example.com', timeout: 30_000, headers: { Authorization: 'Bearer sk-test' } });
  });
});
