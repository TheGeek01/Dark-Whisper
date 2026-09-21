import axios from 'axios';

jest.mock('axios');
jest.mock('fs', () => ({
  existsSync: () => true,
  createReadStream: () => ({ destroy: () => undefined }),
}));
jest.mock('form-data', () =>
  class FakeFormData {
    append(): void {}
    getHeaders(): Record<string, string> {
      return { 'content-type': 'multipart/form-data' };
    }
  });

const post = jest.fn();
(axios.create as jest.Mock) = jest.fn(() => ({ post, get: jest.fn() }));

// Required after the mocks so the module's axios.create() call is captured.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { transcribeAudio } = require('../services/apiService');

describe('transcribe response handling', () => {
  beforeEach(() => post.mockReset());

  it('returns the empty string when VAD hears no speech in the slice', async () => {
    post.mockResolvedValue({ status: 200, data: { text: '' } });
    await expect(transcribeAudio('C:/tmp/block-2.wav')).resolves.toBe('');
  });

  it('returns the transcribed text', async () => {
    post.mockResolvedValue({ status: 200, data: { text: 'hello there' } });
    await expect(transcribeAudio('C:/tmp/block-2.wav')).resolves.toBe('hello there');
  });

  it('still rejects a body that carries no text at all', async () => {
    post.mockResolvedValue({ status: 200, data: { error: 'model not loaded' } });
    await expect(transcribeAudio('C:/tmp/block-2.wav')).rejects.toThrow('Invalid response from API');
  });
});
