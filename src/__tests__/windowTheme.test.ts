import { TITLE_BAR_HEIGHT, titleBarOverlay, windowBackground } from '../services/windowTheme';

describe('windowTheme', () => {
  it('matches the header colours of each theme', () => {
    expect(windowBackground('dark')).toBe('#0f1020');
    expect(windowBackground('light')).toBe('#f6f7fb');
    expect(titleBarOverlay('dark')).toEqual({ color: '#0f1020', symbolColor: '#c9cbe0', height: TITLE_BAR_HEIGHT });
    expect(titleBarOverlay('light')).toEqual({ color: '#f6f7fb', symbolColor: '#3b3d52', height: 56 });
  });
});
