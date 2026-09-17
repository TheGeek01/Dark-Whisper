import { initDialogs } from './dialogs.js';
import { initDocument } from './document.js';
import { initHeader, setSettings } from './header.js';
import { initLibrary } from './library.js';
import { initSessionPanel } from './sessionPanel.js';
import { initTheme } from './theme.js';
import { applyBlock, applySegment, applyStatus } from './sessionModel.js';
import { getState, update } from './state.js';
import { reportError } from './toast.js';

function initSession(): void {
  window.api.onSessionStatus((status) => update({ session: applyStatus(getState().session, status) }));
  window.api.onSessionBlock((event) => update({ session: applyBlock(getState().session, event) }));
  window.api.onSessionSegment((segment) => update({ session: applySegment(getState().session, segment) }));
  window.api.getSessionStatus().then((status) => update({ session: applyStatus(getState().session, status) }), reportError);
}

initDialogs({ onSettingsSaved: setSettings });
initTheme();
initHeader();
initLibrary();
initDocument();
initSessionPanel();
initSession();
