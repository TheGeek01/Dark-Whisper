function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

export function newSessionId(now: Date): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}`;
  const time = `${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;
  return `${date}-${time}`;
}

// SoX writes our own session audio (whisper-stream's --save-audio is not real-time, see
// streamRuntime.ts); files are numbered 1-based per restart of the recorder within a session.
export function audioFileName(index: number): string {
  return `session-${index}.wav`;
}
