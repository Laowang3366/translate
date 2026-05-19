import { describe, expect, it } from 'vitest';
import { createFloatingWindowBounds } from './floatingWindowBounds';

describe('floating window bounds', () => {
  const workArea = { x: 0, y: 0, width: 1200, height: 800 };
  const currentBounds = { x: 0, y: 0, width: 420, height: 332 };

  it('opens near the cursor when there is enough space', () => {
    expect(createFloatingWindowBounds(workArea, { x: 320, y: 240 }, currentBounds)).toEqual({
      x: 334,
      y: 254,
      width: 420,
      height: 332
    });
  });

  it('moves left and upward when the cursor is near the screen edge', () => {
    expect(createFloatingWindowBounds(workArea, { x: 1180, y: 780 }, currentBounds)).toEqual({
      x: 746,
      y: 434,
      width: 420,
      height: 332
    });
  });

  it('keeps the floating window inside the work area', () => {
    expect(createFloatingWindowBounds({ x: 100, y: 100, width: 500, height: 380 }, { x: 105, y: 108 }, currentBounds)).toEqual({
      x: 119,
      y: 122,
      width: 420,
      height: 332
    });
  });

  it('reuses the first recorded top-left position during the current app run', () => {
    expect(
      createFloatingWindowBounds(workArea, { x: 900, y: 620 }, currentBounds, {
        positionMode: 'first-position',
        firstPosition: { x: 160, y: 144 }
      })
    ).toEqual({
      x: 160,
      y: 144,
      width: 420,
      height: 332
    });
  });

  it('uses saved custom top-left coordinates and clamps them to the visible work area', () => {
    expect(
      createFloatingWindowBounds(workArea, { x: 120, y: 90 }, currentBounds, {
        positionMode: 'custom-position',
        customPosition: { x: 980, y: 720 }
      })
    ).toEqual({
      x: 780,
      y: 468,
      width: 420,
      height: 332
    });
  });

  it('falls back to cursor positioning when a fixed mode has no usable point yet', () => {
    expect(
      createFloatingWindowBounds(workArea, { x: 320, y: 240 }, currentBounds, {
        positionMode: 'custom-position',
        customPosition: null
      })
    ).toEqual({
      x: 334,
      y: 254,
      width: 420,
      height: 332
    });
  });
});
