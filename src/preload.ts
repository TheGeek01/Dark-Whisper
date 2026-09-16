import { contextBridge, ipcRenderer } from 'electron';
import type { DownloadProgress, ModelEntry } from './services/modelManager';
import type { ServerStatusView } from './services/serverGate';
import type { SessionStatusView } from './services/sessionRuntime';
import type { CaptureDevice } from './services/streamOutput';
import type { BlockEvent } from './shared/api';

interface ModelList {
  models: ModelEntry[];
  activeModelId: string | null;
  downloading: boolean;
  disk: { usedBytes: number; freeBytes: number };
}

contextBridge.exposeInMainWorld('api', {
  onTranscriptionComplete: (callback: (data: { transcription: string }) => void) => {
    ipcRenderer.on('transcription-complete', (event, data) => {
      callback(data);
    });
  },
  onError: (callback: (data: { message: string }) => void) => {
    ipcRenderer.on('error', (event, data) => {
      callback(data);
    });
  },
  onRecordingStarted: (callback: () => void) => {
    ipcRenderer.on('recording-started', () => {
      callback();
    });
  },
  onRecordingStopped: (callback: () => void) => {
    ipcRenderer.on('recording-stopped', () => {
      callback();
    });
  },
  getStatus: (callback: (data: { isRecording: boolean }) => void) => {
    ipcRenderer.invoke('get-status').then(callback);
  },
  startRecording: () => {
    return ipcRenderer.invoke('start-recording');
  },
  stopRecording: () => {
    return ipcRenderer.invoke('stop-recording');
  },
  getSettings: () => {
    return ipcRenderer.invoke('get-settings');
  },
  saveSettings: (settings: any) => {
    return ipcRenderer.invoke('save-settings', settings);
  },
  copyToClipboard: () => {
    return ipcRenderer.invoke('copy-to-clipboard');
  },
  getAudioDevices: () => {
    return ipcRenderer.invoke('get-audio-devices');
  },
  getServerStatus: (): Promise<ServerStatusView> => ipcRenderer.invoke('get-server-status'),
  restartServer: (): Promise<void> => ipcRenderer.invoke('restart-server'),
  openServerLog: (): Promise<void> => ipcRenderer.invoke('open-server-log'),
  listModels: (): Promise<ModelList> => ipcRenderer.invoke('list-models'),
  downloadModel: (id: string): Promise<void> => ipcRenderer.invoke('download-model', id),
  downloadCustomModel: (url: string): Promise<void> => ipcRenderer.invoke('download-custom-model', url),
  cancelDownload: (): Promise<void> => ipcRenderer.invoke('cancel-download'),
  deleteModel: (id: string): Promise<void> => ipcRenderer.invoke('delete-model', id),
  selectModel: (id: string): Promise<void> => ipcRenderer.invoke('select-model', id),
  onServerStatus: (callback: (status: ServerStatusView) => void) => {
    ipcRenderer.on('server-status', (_event, status: ServerStatusView) => callback(status));
  },
  onDownloadProgress: (callback: (progress: DownloadProgress) => void) => {
    ipcRenderer.on('download-progress', (_event, progress: DownloadProgress) => callback(progress));
  },
  onOpenModels: (callback: () => void) => {
    ipcRenderer.on('open-models', () => callback());
  },
  startSession: (folder?: string): Promise<SessionStatusView> => ipcRenderer.invoke('session-start', folder),
  pauseSession: (): Promise<void> => ipcRenderer.invoke('session-pause'),
  resumeSession: (): Promise<void> => ipcRenderer.invoke('session-resume'),
  stopSession: (): Promise<void> => ipcRenderer.invoke('session-stop'),
  getSessionStatus: (): Promise<SessionStatusView> => ipcRenderer.invoke('session-status'),
  listCaptureDevices: (): Promise<CaptureDevice[]> => ipcRenderer.invoke('list-capture-devices'),
  openVault: (): Promise<void> => ipcRenderer.invoke('open-vault'),
  revealDocument: (): Promise<void> => ipcRenderer.invoke('reveal-document'),
  onSessionStatus: (callback: (view: SessionStatusView) => void) => {
    ipcRenderer.on('session-status', (_event, view: SessionStatusView) => callback(view));
  },
  onSessionSegment: (callback: (segment: { text: string; blockIndex: number }) => void) => {
    ipcRenderer.on('session-segment', (_event, segment: { text: string; blockIndex: number }) => callback(segment));
  },
  onSessionBlock: (callback: (event: BlockEvent) => void) => {
    ipcRenderer.on('session-block', (_event, payload: BlockEvent) => callback(payload));
  },
});

declare global {
  interface Window {
    api: {
      onTranscriptionComplete: (callback: (data: { transcription: string }) => void) => void;
      onError: (callback: (data: { message: string }) => void) => void;
      onRecordingStarted: (callback: () => void) => void;
      onRecordingStopped: (callback: () => void) => void;
      getStatus: (callback: (data: { isRecording: boolean }) => void) => void;
      startRecording: () => Promise<void>;
      stopRecording: () => Promise<void>;
      getSettings: () => Promise<any>;
      saveSettings: (settings: any) => Promise<any>;
      copyToClipboard: () => Promise<{ success: boolean; message?: string }>;
      getAudioDevices: () => Promise<Array<{ id: string; name: string }>>;
      getServerStatus: () => Promise<ServerStatusView>;
      restartServer: () => Promise<void>;
      openServerLog: () => Promise<void>;
      listModels: () => Promise<ModelList>;
      downloadModel: (id: string) => Promise<void>;
      downloadCustomModel: (url: string) => Promise<void>;
      cancelDownload: () => Promise<void>;
      deleteModel: (id: string) => Promise<void>;
      selectModel: (id: string) => Promise<void>;
      onServerStatus: (callback: (status: ServerStatusView) => void) => void;
      onDownloadProgress: (callback: (progress: DownloadProgress) => void) => void;
      onOpenModels: (callback: () => void) => void;
      startSession: (folder?: string) => Promise<SessionStatusView>;
      pauseSession: () => Promise<void>;
      resumeSession: () => Promise<void>;
      stopSession: () => Promise<void>;
      getSessionStatus: () => Promise<SessionStatusView>;
      listCaptureDevices: () => Promise<CaptureDevice[]>;
      openVault: () => Promise<void>;
      revealDocument: () => Promise<void>;
      onSessionStatus: (callback: (view: SessionStatusView) => void) => void;
      onSessionSegment: (callback: (segment: { text: string; blockIndex: number }) => void) => void;
      onSessionBlock: (callback: (event: BlockEvent) => void) => void;
    };
  }
}
