export type Point = {
  x: number;
  y: number;
};

export type Rect = Point & {
  width: number;
  height: number;
};

export type FloatingWindowBoundsOptions = {
  margin?: number;
  positionMode?: 'follow-cursor' | 'first-position' | 'custom-position';
  firstPosition?: Point | null;
  customPosition?: Point | null;
};

export function createFloatingWindowBounds(
  workArea: Rect,
  cursorPoint: Point,
  currentBounds: Rect,
  optionsOrMargin: number | FloatingWindowBoundsOptions = 14
): Rect {
  const options = normalizeFloatingWindowBoundsOptions(optionsOrMargin);
  const fixedPosition =
    options.positionMode === 'custom-position' && options.customPosition
      ? options.customPosition
      : options.positionMode === 'first-position' && options.firstPosition
        ? options.firstPosition
        : null;

  if (fixedPosition) {
    return createFixedFloatingWindowBounds(workArea, fixedPosition, currentBounds);
  }

  return createCursorFloatingWindowBounds(workArea, cursorPoint, currentBounds, options.margin);
}

function normalizeFloatingWindowBoundsOptions(optionsOrMargin: number | FloatingWindowBoundsOptions): Required<FloatingWindowBoundsOptions> {
  if (typeof optionsOrMargin === 'number') {
    return {
      margin: optionsOrMargin,
      positionMode: 'follow-cursor',
      firstPosition: null,
      customPosition: null
    };
  }

  return {
    margin: typeof optionsOrMargin.margin === 'number' ? optionsOrMargin.margin : 14,
    positionMode: optionsOrMargin.positionMode ?? 'follow-cursor',
    firstPosition: optionsOrMargin.firstPosition ?? null,
    customPosition: optionsOrMargin.customPosition ?? null
  };
}

function createCursorFloatingWindowBounds(workArea: Rect, cursorPoint: Point, currentBounds: Rect, margin: number): Rect {
  const preferredX = cursorPoint.x + margin;
  const preferredY = cursorPoint.y + margin;
  const maxX = workArea.x + workArea.width;
  const maxY = workArea.y + workArea.height;

  return {
    x:
      preferredX + currentBounds.width > maxX
        ? Math.max(workArea.x + margin, cursorPoint.x - currentBounds.width - margin)
        : Math.max(workArea.x + margin, preferredX),
    y:
      preferredY + currentBounds.height > maxY
        ? Math.max(workArea.y + margin, cursorPoint.y - currentBounds.height - margin)
        : Math.max(workArea.y + margin, preferredY),
    width: currentBounds.width,
    height: currentBounds.height
  };
}

function createFixedFloatingWindowBounds(workArea: Rect, fixedPosition: Point, currentBounds: Rect): Rect {
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - currentBounds.width);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - currentBounds.height);

  return {
    x: Math.min(Math.max(fixedPosition.x, workArea.x), maxX),
    y: Math.min(Math.max(fixedPosition.y, workArea.y), maxY),
    width: currentBounds.width,
    height: currentBounds.height
  };
}
