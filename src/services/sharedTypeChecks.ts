// Compile-time only: the build fails if a main-process type drifts from the shape the renderer relies on.
import type {
  DownloadProgressView,
  ModelEntryView,
  ServerStatusView as SharedServerStatusView,
  SettingsView,
} from '../shared/api';
import type { DownloadProgress, ModelEntry } from './modelManager';
import type { ServerStatusView } from './serverGate';
import type { Settings } from './settingsService';

type Assignable<From, To> = From extends To ? true : false;

export type SharedTypeChecks = [
  Assignable<ModelEntry, ModelEntryView>,
  Assignable<DownloadProgress, DownloadProgressView>,
  Assignable<ServerStatusView, SharedServerStatusView>,
  Assignable<Settings, SettingsView>,
];

export const sharedTypeChecks: SharedTypeChecks = [true, true, true, true];
