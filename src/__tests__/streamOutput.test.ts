import { parseStreamLine, stripAnsi, isNoiseSegment, READY_MARKER } from '../services/streamOutput';

describe('streamOutput', () => {
  describe('stripAnsi', () => {
    it('removes the redraw sequences stream.exe emits', () => {
      expect(stripAnsi('\u001b[2K\rhello')).toBe('hello');
      expect(stripAnsi('plain')).toBe('plain');
    });
  });

  describe('parseStreamLine', () => {
    describe('stdout behavior', () => {
      it('recognises the ready marker on stdout', () => {
        expect(READY_MARKER).toBe('[Start speaking]');
        expect(parseStreamLine('[Start speaking]', 'stdout')).toEqual({ kind: 'ready' });
      });

      it('reads a timestamped segment and drops the timestamps', () => {
        expect(parseStreamLine('[00:00:01.000 --> 00:00:04.000]   And so my fellow Americans', 'stdout')).toEqual({
          kind: 'segment',
          text: 'And so my fellow Americans',
        });
      });

      it('reads a bare segment line', () => {
        expect(parseStreamLine('ask not what your country can do for you', 'stdout')).toEqual({
          kind: 'segment',
          text: 'ask not what your country can do for you',
        });
      });

      it('preserves speech with colons in the text (regression test for diagnostic filter bug)', () => {
        expect(parseStreamLine('12:30 is when we start', 'stdout')).toEqual({
          kind: 'segment',
          text: '12:30 is when we start',
        });
        expect(parseStreamLine('note: do not forget the milk', 'stdout')).toEqual({
          kind: 'segment',
          text: 'note: do not forget the milk',
        });
        expect(parseStreamLine('ok: sounds good', 'stdout')).toEqual({
          kind: 'segment',
          text: 'ok: sounds good',
        });
        expect(parseStreamLine('3:00 PM meeting with the team', 'stdout')).toEqual({
          kind: 'segment',
          text: '3:00 PM meeting with the team',
        });
      });

      it('ignores VAD mode segment markers that start with "### "', () => {
        expect(parseStreamLine('### Transcription 7 END', 'stdout')).toBeNull();
        expect(parseStreamLine('### Transcription 1 START | t0 = 0 ms | t1 = 3000 ms', 'stdout')).toBeNull();
      });

      it('preserves speech containing hash characters (regression test)', () => {
        expect(parseStreamLine('the issue is #42 in the tracker', 'stdout')).toEqual({
          kind: 'segment',
          text: 'the issue is #42 in the tracker',
        });
      });

      it('ignores empty and whitespace-only lines on stdout', () => {
        expect(parseStreamLine('', 'stdout')).toBeNull();
        expect(parseStreamLine('   ', 'stdout')).toBeNull();
      });

      it('strips ANSI before deciding on stdout', () => {
        expect(parseStreamLine('\u001b[2K\r[Start speaking]', 'stdout')).toEqual({ kind: 'ready' });
      });
    });

    describe('stderr behavior', () => {
      it('reads capture devices from stderr', () => {
        expect(parseStreamLine("init:    - Capture device #0: 'Microphone (Realtek Audio)'", 'stderr')).toEqual({
          kind: 'device',
          device: { index: 0, name: 'Microphone (Realtek Audio)' },
        });
        expect(parseStreamLine("init:    - Capture device #2: 'Headset (Jabra)'", 'stderr')).toEqual({
          kind: 'device',
          device: { index: 2, name: 'Headset (Jabra)' },
        });
      });

      it('recognises failures on stderr', () => {
        expect(parseStreamLine("init: couldn't open an audio device for capture: No such device!", 'stderr')).toEqual({
          kind: 'capture-failed',
        });
        expect(parseStreamLine('error: failed to initialize whisper context', 'stderr')).toEqual({
          kind: 'model-load-failed',
        });
      });

      it('ignores diagnostic noise on stderr', () => {
        expect(parseStreamLine('main: found 3 capture devices:', 'stderr')).toBeNull();
        expect(parseStreamLine("init: attempt to open capture device 0 : 'Microphone' ...", 'stderr')).toBeNull();
        expect(parseStreamLine('init:     - sample rate:       16000', 'stderr')).toBeNull();
        expect(parseStreamLine('whisper_init_from_file_with_params_no_state: loading model from ggml-base.en.bin', 'stderr')).toBeNull();
        expect(parseStreamLine('whisper_backend_init_gpu: no GPU found', 'stderr')).toBeNull();
        expect(parseStreamLine('system_info: n_threads = 4', 'stderr')).toBeNull();
        expect(parseStreamLine('load_backend: loaded CPU backend from C:\\x\\ggml-cpu-alderlake.dll', 'stderr')).toBeNull();
        expect(parseStreamLine('whisper_model_load: model size = 147.37 MB', 'stderr')).toBeNull();
      });

      it('does not emit transcript text from stderr', () => {
        // If transcript text appears on stderr (should not happen in normal operation),
        // it is ignored as diagnostic noise, not emitted as a segment
        expect(parseStreamLine('And so my fellow Americans', 'stderr')).toBeNull();
        expect(parseStreamLine('hello world', 'stderr')).toBeNull();
      });

      it('ignores empty and whitespace-only lines on stderr', () => {
        expect(parseStreamLine('', 'stderr')).toBeNull();
        expect(parseStreamLine('   ', 'stderr')).toBeNull();
      });
    });
  });

  describe('isNoiseSegment', () => {
    it.each(['[BLANK_AUDIO]', '(blank audio)', '[ Silence ]', '(buzzing)', '...', '', '  '])(
      'treats %p as noise',
      (text) => {
        expect(isNoiseSegment(text)).toBe(true);
      },
    );

    it('keeps real speech', () => {
      expect(isNoiseSegment('Hello there.')).toBe(false);
      expect(isNoiseSegment('(pause) but then we continued')).toBe(false);
    });
  });
});
