import { initialServerMode } from '../services/settingsMigration';

describe('initialServerMode', () => {
  it('keeps existing installs on the external API', () => {
    expect(initialServerMode(true)).toBe('external');
  });

  it('defaults fresh installs to the built-in server', () => {
    expect(initialServerMode(false)).toBe('builtin');
  });
});
