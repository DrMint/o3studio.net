import {
  getDocument,
  GlobalWorkerOptions,
  RenderingCancelledException,
  TextLayer,
} from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { initChapterScrubber } from "./chapter-scrubber";
import { loadPdfChapters } from "./pdf-chapters";

GlobalWorkerOptions.workerSrc = pdfWorker;

type SpreadPages = {
  left: number | null;
  right: number | null;
};

function pagesForSpread(spread: number, pageCount: number): SpreadPages {
  const left = 2 * spread;
  const right = 2 * spread + 1;
  return {
    left: left >= 1 && left <= pageCount ? left : null,
    right: right <= pageCount ? right : null,
  };
}

function maxSpread(pageCount: number): number {
  return Math.floor(pageCount / 2);
}

function spreadForPage(page: number): number {
  return Math.floor(page / 2);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Side-stack thickness as a fraction of page-face width, per page in the stack.
 * e.g. 0.001 → 100 unread pages ≈ 10% of the face width.
 */
const EDGE_WIDTH_PER_PAGE = 0.0003;
/** Extra stack scale per page on that side (≈1.06 at 300 pages). */
const STACK_SCALE_PER_PAGE = 0.05 / 300;
/** Horizontal hardcover peek beyond the page stack, as a fraction of page-face width. */
const COVER_OVERHANG_RATIO_X = 0.025;
/** Top hardcover peek beyond the page stack, as a fraction of page-face width. */
const COVER_OVERHANG_RATIO_TOP = 0.02;
/** Bottom hardcover peek beyond the page stack, as a fraction of page-face width. */
const COVER_OVERHANG_RATIO_BOTTOM = 0.02;
const ZOOM_MIN = 0.68;
const ZOOM_MAX = 3.83;
const ZOOM_STEP = 0.25;
/** Wait for zoom gestures to settle before asking pdf.js to re-rasterize. */
const ZOOM_SETTLE_MS = 140;
/** Keep current ± this many spreads rasterized for instant page turns. */
const PREFETCH_SPREAD_RADIUS = 1;
const RASTER_CACHE_LIMIT = 12;

function progressStorageKey(bookId: string): string {
  return `o3studio:book-progress:${bookId}`;
}

function readSavedPage(bookId: string): number | null {
  try {
    const raw = localStorage.getItem(progressStorageKey(bookId));
    if (raw === null) return null;
    const page = Number(raw);
    return Number.isFinite(page) ? page : null;
  } catch {
    return null;
  }
}

function writeSavedPage(bookId: string, page: number) {
  try {
    localStorage.setItem(progressStorageKey(bookId), String(page));
  } catch {
    // Private mode / quota — resume is best-effort.
  }
}

export async function initBookReader(root: HTMLElement): Promise<void> {
  const pdfUrl = root.dataset.pdfUrl;
  if (!pdfUrl) throw new Error("Missing data-pdf-url");
  const bookId = root.dataset.bookId ?? "";
  if (!bookId) throw new Error("Missing data-book-id");

  const spreadEl = mustQuery(root, "#spread");
  const zoomShell = mustQuery(root, "#book-zoom-shell");
  const bookEl = mustQuery(root, "#book");
  const leftBtn = mustQuery(root, "[data-page='left']");
  const rightBtn = mustQuery(root, "[data-page='right']");
  const leftStack = mustQuery(leftBtn, ".page-stack");
  const rightStack = mustQuery(rightBtn, ".page-stack");
  const leftFace = mustQuery(leftBtn, ".page-face");
  const rightFace = mustQuery(rightBtn, ".page-face");
  const leftCanvas = mustQuery(leftBtn, "canvas") as HTMLCanvasElement;
  const rightCanvas = mustQuery(rightBtn, "canvas") as HTMLCanvasElement;
  const leftText = mustQuery(leftBtn, ".textLayer");
  const rightText = mustQuery(rightBtn, ".textLayer");
  const pageInput = mustQuery(root, "[data-page-input]") as HTMLInputElement;
  const pageScrubberEl = mustQuery(root, "[data-page-scrubber]");
  const pageCountLabel = mustQuery(root, "[data-page-count]");
  const zoomInBtn = mustQuery(root, "[data-zoom-in]");
  const zoomOutBtn = mustQuery(root, "[data-zoom-out]");
  const zoomResetBtn = mustQuery(root, "[data-zoom-reset]");
  const zoomLabel = mustQuery(root, "[data-zoom-label]");
  const turnPrevBtn = mustQuery(
    root,
    "[data-turn='prev']"
  ) as HTMLButtonElement;
  const turnNextBtn = mustQuery(
    root,
    "[data-turn='next']"
  ) as HTMLButtonElement;
  const fullscreenEnterBtn = mustQuery(
    root,
    "#fullscreen-enter"
  ) as HTMLButtonElement;
  const fullscreenExitBtn = mustQuery(
    root,
    "#fullscreen-exit"
  ) as HTMLButtonElement;
  const spreadArea = mustQuery(root, "#spread-area");

  const pdf = await getDocument({ url: pdfUrl }).promise;
  const pageCount = pdf.numPages;
  const savedPage = readSavedPage(bookId);
  let spread =
    savedPage === null
      ? 0
      : spreadForPage(clamp(Math.round(savedPage), 1, pageCount));
  let zoom = 1;
  /** Zoom level of the canvases currently on screen. */
  let renderedZoom = 1;
  let renderedLayout = { w: 0, h: 0 };
  let renderToken = 0;
  /** Bumped when CSS page size / DPR changes so stale prefetches stop. */
  let layoutEpoch = 0;
  let lastRasterLayout: { w: number; h: number; dpr: number } | null = null;
  let zoomTimer: ReturnType<typeof setTimeout> | undefined;
  const renderTasks = new Map<HTMLCanvasElement, RenderTask>();
  const textLayers = new Map<HTMLElement, TextLayer>();
  /** Offscreen rasters keyed by page + layout; avoids blanking the visible canvas. */
  const rasterCache = new Map<string, HTMLCanvasElement>();
  const inflightRasters = new Map<string, Promise<HTMLCanvasElement | null>>();

  pageInput.max = String(pageCount);
  pageCountLabel.textContent = `/ ${pageCount}`;
  const chapters = await loadPdfChapters(pdf);
  bookEl.style.setProperty(
    "--spine-thickness",
    String(pageCount * EDGE_WIDTH_PER_PAGE * 2)
  );
  syncZoomUi();

  turnPrevBtn.addEventListener("click", () => goSpread(-1));
  turnNextBtn.addEventListener("click", () => goSpread(1));

  function isSpreadFullscreen(): boolean {
    return document.fullscreenElement === spreadArea;
  }

  function syncFullscreenUi() {
    fullscreenExitBtn.hidden = !isSpreadFullscreen();
  }

  async function enterFullscreen() {
    if (isSpreadFullscreen()) return;
    try {
      await spreadArea.requestFullscreen();
    } catch {
      // User gesture denied / unsupported — ignore.
    }
  }

  async function exitFullscreen() {
    if (!document.fullscreenElement) return;
    try {
      await document.exitFullscreen();
    } catch {
      // Already exited / unsupported — ignore.
    }
  }

  fullscreenEnterBtn.addEventListener("click", () => void enterFullscreen());
  fullscreenExitBtn.addEventListener("click", () => void exitFullscreen());
  document.addEventListener("fullscreenchange", () => {
    syncFullscreenUi();
    // Layout often isn't final yet on fullscreenchange — wait for paint.
    scheduleFit();
  });
  syncFullscreenUi();

  let fitFrame = 0;
  function scheduleFit() {
    window.cancelAnimationFrame(fitFrame);
    fitFrame = window.requestAnimationFrame(() => {
      fitFrame = window.requestAnimationFrame(() => {
        if (spreadEl.clientWidth < 1 || spreadEl.clientHeight < 1) return;
        void showSpread();
      });
    });
  }

  window.addEventListener("resize", scheduleFit);

  /** One spread per gesture — trackpads send large deltas that would skip pages. */
  const WHEEL_PAGE_THRESHOLD = 40;
  const WHEEL_FLIP_COOLDOWN_MS = 30;
  let wheelPageDelta = 0;
  let wheelFlipLocked = false;
  let wheelFlipTimer: ReturnType<typeof setTimeout> | undefined;

  function onReaderWheel(event: WheelEvent) {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      wheelPageDelta = 0;
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setZoom(zoom * factor, true);
      return;
    }

    // At fit zoom there's nothing to pan — use the wheel to turn pages.
    if (zoom <= 1.001) {
      event.preventDefault();
      if (wheelFlipLocked) return;
      const delta =
        Math.abs(event.deltaY) >= Math.abs(event.deltaX)
          ? event.deltaY
          : event.deltaX;
      if (delta === 0) return;
      if (
        Math.sign(delta) !== Math.sign(wheelPageDelta) &&
        wheelPageDelta !== 0
      ) {
        wheelPageDelta = 0;
      }
      wheelPageDelta += delta;
      if (Math.abs(wheelPageDelta) < WHEEL_PAGE_THRESHOLD) return;

      const direction = wheelPageDelta > 0 ? 1 : -1;
      wheelPageDelta = 0;
      wheelFlipLocked = true;
      goSpread(direction);
      window.clearTimeout(wheelFlipTimer);
      wheelFlipTimer = setTimeout(() => {
        wheelFlipLocked = false;
        wheelFlipTimer = undefined;
      }, WHEEL_FLIP_COOLDOWN_MS);
      return;
    }

    wheelPageDelta = 0;
    // Turn buttons sit above the scroller; forward wheel to pan when zoomed.
    if (event.currentTarget !== spreadEl) {
      spreadEl.scrollTop += event.deltaY;
      spreadEl.scrollLeft += event.deltaX;
    }
  }

  // Buttons sit above the scroller; keep wheel-zoom/pan/page-turn working over them.
  for (const btn of [turnPrevBtn, turnNextBtn, fullscreenExitBtn]) {
    btn.addEventListener("wheel", onReaderWheel, { passive: false });
  }

  window.addEventListener("keydown", (event) => {
    if (isEditableTarget(event.target)) return;
    if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      goSpread(-1);
      return;
    }
    if (event.key === "ArrowRight" || event.key === "PageDown") {
      event.preventDefault();
      goSpread(1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      goToPage(1);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      goToPage(pageCount);
    }
  });

  const pageScrubber = initChapterScrubber(pageScrubberEl, {
    pageCount,
    chapters,
    getPage: () => displayedPage(),
    onSeek: (page) => goToPage(page),
    onStep: (delta) => goSpread(delta),
  });

  zoomInBtn.addEventListener("click", () => {
    setZoom(zoom + ZOOM_STEP);
  });
  zoomOutBtn.addEventListener("click", () => {
    setZoom(zoom - ZOOM_STEP);
  });
  zoomResetBtn.addEventListener("click", () => {
    setZoom(1);
  });

  spreadEl.addEventListener("wheel", onReaderWheel, { passive: false });

  let pinchStartDistance = 0;
  let pinchStartZoom = 1;

  function touchDistance(a: Touch, b: Touch): number {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function onPinchStart(event: TouchEvent) {
    if (event.touches.length !== 2) return;
    pinchStartDistance = touchDistance(event.touches[0]!, event.touches[1]!);
    pinchStartZoom = zoom;
    wheelPageDelta = 0;
  }

  function onPinchMove(event: TouchEvent) {
    if (event.touches.length !== 2 || pinchStartDistance < 1) return;
    event.preventDefault();
    const distance = touchDistance(event.touches[0]!, event.touches[1]!);
    setZoom(pinchStartZoom * (distance / pinchStartDistance), true);
  }

  function onPinchEnd(event: TouchEvent) {
    if (event.touches.length < 2) pinchStartDistance = 0;
  }

  // Pinch-to-zoom (bubbles from book, turn controls, etc.).
  spreadArea.addEventListener("touchstart", onPinchStart, { passive: true });
  spreadArea.addEventListener("touchmove", onPinchMove, { passive: false });
  spreadArea.addEventListener("touchend", onPinchEnd);
  spreadArea.addEventListener("touchcancel", onPinchEnd);

  let editingPageInput = false;

  pageInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      editingPageInput = false;
      goSpread(1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      editingPageInput = false;
      goSpread(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      editingPageInput = false;
      goToPage(Number(pageInput.value));
      pageInput.blur();
      return;
    }
    if (
      event.key.length === 1 ||
      event.key === "Backspace" ||
      event.key === "Delete"
    ) {
      editingPageInput = true;
    }
  });

  pageInput.addEventListener("input", () => {
    // Spinner clicks (and similar nudges) fire input without typing keydowns.
    if (editingPageInput) return;
    const requested = Number(pageInput.value);
    const current = displayedPage();
    if (!Number.isFinite(requested)) {
      syncPager();
      return;
    }
    if (requested > current) goSpread(1);
    else if (requested < current) goSpread(-1);
    else syncPager();
  });

  pageInput.addEventListener("change", () => {
    editingPageInput = false;
    goToPage(Number(pageInput.value));
  });

  pageInput.addEventListener("blur", () => {
    editingPageInput = false;
  });

  await showSpread();
  // Observe after the first paint so the initial RO callback can't cancel it
  // with a zero-size layout measurement.
  new ResizeObserver(scheduleFit).observe(spreadEl);

  function displayedPage(): number {
    const { left, right } = pagesForSpread(spread, pageCount);
    return left ?? right ?? 1;
  }

  function goSpread(delta: number) {
    window.clearTimeout(zoomTimer);
    zoomTimer = undefined;
    const next = clamp(spread + delta, 0, maxSpread(pageCount));
    if (next === spread) {
      syncPager();
      return;
    }
    spread = next;
    void showSpread();
  }

  function goToPage(page: number) {
    window.clearTimeout(zoomTimer);
    zoomTimer = undefined;
    if (!Number.isFinite(page)) {
      syncPager();
      return;
    }
    const next = clamp(Math.round(page), 1, pageCount);
    const nextSpread = spreadForPage(next);
    if (nextSpread === spread) {
      syncPager();
      return;
    }
    spread = nextSpread;
    void showSpread();
  }

  function syncPager() {
    const currentPage = displayedPage();
    pageInput.value = String(currentPage);
    pageScrubber.setPage(currentPage);
    writeSavedPage(bookId, currentPage);
  }

  function syncZoomUi() {
    const rounded = Math.round(zoom * 100);
    zoomLabel.textContent = `${rounded}%`;
    bookEl.dataset.zoomed = zoom > 1.001 ? "true" : "false";
    (zoomOutBtn as HTMLButtonElement).disabled = zoom <= ZOOM_MIN + 0.001;
    (zoomInBtn as HTMLButtonElement).disabled = zoom >= ZOOM_MAX - 0.001;
  }

  function applyZoomPreview() {
    const scale = zoom / renderedZoom;
    if (!renderedLayout.w || Math.abs(scale - 1) < 0.001) {
      bookEl.style.transform = "";
      zoomShell.style.width = "";
      zoomShell.style.height = "";
      bookEl.classList.remove("is-preview-zoom");
      return;
    }
    zoomShell.style.width = `${renderedLayout.w * scale}px`;
    zoomShell.style.height = `${renderedLayout.h * scale}px`;
    bookEl.style.transform = `scale(${scale})`;
    bookEl.classList.add("is-preview-zoom");
  }

  function setZoom(next: number, fromWheel = false) {
    if (fromWheel) {
      zoom = clamp(Math.round(next * 100) / 100, ZOOM_MIN, ZOOM_MAX);
    } else {
      zoom = clamp(
        Math.round(next / ZOOM_STEP) * ZOOM_STEP,
        ZOOM_MIN,
        ZOOM_MAX
      );
    }
    syncZoomUi();
    // Instant CSS scale while pdf.js catches up at settle time.
    applyZoomPreview();
    window.clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      zoomTimer = undefined;
      void showSpread();
    }, ZOOM_SETTLE_MS);
  }

  function cancelRender(canvas: HTMLCanvasElement) {
    const task = renderTasks.get(canvas);
    if (!task) return;
    task.cancel();
    renderTasks.delete(canvas);
  }

  function cancelTextLayer(container: HTMLElement) {
    const layer = textLayers.get(container);
    if (!layer) return;
    layer.cancel();
    textLayers.delete(container);
  }

  function clearTextLayer(container: HTMLElement) {
    cancelTextLayer(container);
    container.replaceChildren();
    container.hidden = true;
  }

  function rasterKey(
    pageNumber: number,
    cssWidth: number,
    cssHeight: number,
    dpr: number
  ): string {
    return `${pageNumber}:${cssWidth}x${cssHeight}@${dpr}`;
  }

  function rememberRaster(key: string, canvas: HTMLCanvasElement) {
    rasterCache.delete(key);
    rasterCache.set(key, canvas);
    while (rasterCache.size > RASTER_CACHE_LIMIT) {
      const oldest = rasterCache.keys().next().value;
      if (oldest === undefined) break;
      rasterCache.delete(oldest);
    }
  }

  function invalidateRasterCache() {
    layoutEpoch++;
    rasterCache.clear();
    inflightRasters.clear();
  }

  function syncRasterLayout(cssWidth: number, cssHeight: number): number {
    const dpr = window.devicePixelRatio || 1;
    const prev = lastRasterLayout;
    if (
      !prev ||
      prev.w !== cssWidth ||
      prev.h !== cssHeight ||
      prev.dpr !== dpr
    ) {
      invalidateRasterCache();
      lastRasterLayout = { w: cssWidth, h: cssHeight, dpr };
    }
    return layoutEpoch;
  }

  async function getRaster(
    doc: PDFDocumentProxy,
    pageNumber: number,
    cssWidth: number,
    cssHeight: number,
    token?: number
  ): Promise<HTMLCanvasElement | null> {
    const dpr = window.devicePixelRatio || 1;
    const key = rasterKey(pageNumber, cssWidth, cssHeight, dpr);
    const cached = rasterCache.get(key);
    if (cached) {
      rememberRaster(key, cached);
      return cached;
    }

    const existing = inflightRasters.get(key);
    if (existing) {
      const shared = await existing;
      if (token !== undefined && token !== renderToken) return null;
      return shared;
    }

    const pending = (async (): Promise<HTMLCanvasElement | null> => {
      const epochAtStart = layoutEpoch;
      const page: PDFPageProxy = await doc.getPage(pageNumber);
      if (token !== undefined && token !== renderToken) return null;
      if (epochAtStart !== layoutEpoch) return null;

      const base = page.getViewport({ scale: 1 });
      const cssScale = cssWidth / base.width;
      const canvasViewport = page.getViewport({
        scale: cssScale * dpr,
      });

      const offscreen = document.createElement("canvas");
      offscreen.width = Math.floor(canvasViewport.width);
      offscreen.height = Math.floor(canvasViewport.height);
      const context = offscreen.getContext("2d");
      if (!context) return null;

      const task = page.render({
        canvas: offscreen,
        canvasContext: context,
        viewport: canvasViewport,
      });
      renderTasks.set(offscreen, task);
      try {
        await task.promise;
      } catch (error) {
        if (error instanceof RenderingCancelledException) return null;
        throw error;
      } finally {
        if (renderTasks.get(offscreen) === task) renderTasks.delete(offscreen);
      }

      if (token !== undefined && token !== renderToken) return null;
      if (epochAtStart !== layoutEpoch) return null;

      rememberRaster(key, offscreen);
      return offscreen;
    })();

    inflightRasters.set(key, pending);
    try {
      return await pending;
    } finally {
      if (inflightRasters.get(key) === pending) inflightRasters.delete(key);
    }
  }

  function pagesAroundSpread(center: number): number[] {
    const pages = new Set<number>();
    const max = maxSpread(pageCount);
    for (
      let s = center - PREFETCH_SPREAD_RADIUS;
      s <= center + PREFETCH_SPREAD_RADIUS;
      s++
    ) {
      if (s < 0 || s > max) continue;
      const { left, right } = pagesForSpread(s, pageCount);
      if (left !== null) pages.add(left);
      if (right !== null) pages.add(right);
    }
    return [...pages];
  }

  function prefetchAdjacent(
    center: number,
    cssWidth: number,
    cssHeight: number,
    epoch: number
  ) {
    const pages = pagesAroundSpread(center).filter((pageNumber) => {
      const { left, right } = pagesForSpread(center, pageCount);
      return pageNumber !== left && pageNumber !== right;
    });

    void (async () => {
      for (const pageNumber of pages) {
        if (epoch !== layoutEpoch) return;
        await getRaster(pdf, pageNumber, cssWidth, cssHeight);
      }
    })();
  }

  async function showSpread() {
    // Don't bump renderToken until we know the stage has a real size — otherwise
    // a zero-size fit (common right as fullscreen/layout settles) cancels a good render.
    if (spreadEl.clientWidth < 1 || spreadEl.clientHeight < 1) return;

    const token = ++renderToken;
    const { left, right } = pagesForSpread(spread, pageCount);
    const canPrev = spread > 0;
    const canNext = spread < maxSpread(pageCount);
    const samplePageNumber = left ?? right;
    if (samplePageNumber === null) return;

    leftBtn.dataset.empty = String(left === null);
    rightBtn.dataset.empty = String(right === null);
    // End-sheet pastedowns: page 2 (front) and pageCount − 1 (back, mirrored).
    const backPastedownPage = pageCount > 2 ? pageCount - 1 : null;
    const pastedownFor = (page: number | null): "front" | "back" | null => {
      if (page === null) return null;
      if (page === 2) return "front";
      if (backPastedownPage !== null && page === backPastedownPage)
        return "back";
      return null;
    };
    const leftPastedown = pastedownFor(left);
    const rightPastedown = pastedownFor(right);
    if (leftPastedown) leftBtn.dataset.pastedown = leftPastedown;
    else delete leftBtn.dataset.pastedown;
    if (rightPastedown) rightBtn.dataset.pastedown = rightPastedown;
    else delete rightBtn.dataset.pastedown;
    turnPrevBtn.disabled = !canPrev;
    turnNextBtn.disabled = !canNext;
    syncPager();

    const closed = left === null || right === null;
    bookEl.dataset.closed = String(closed);
    if (closed) {
      bookEl.dataset.cover = right !== null ? "front" : "back";
    } else {
      delete bookEl.dataset.cover;
    }

    const firstPage = left ?? right!;
    const lastPage = right ?? left!;
    const pagesRead = firstPage - 1;
    const pagesRemaining = pageCount - lastPage;
    const bookProgress = pageCount > 0 ? pagesRead / pageCount : 0;
    bookEl.style.setProperty("--book-progress", String(bookProgress));
    // Pastedowns (page 2 / pageCount−1) are endpapers, not stack leaves.
    const leftEdgePages = Math.max(0, pagesRead - 1);
    const rightEdgePages = Math.max(0, pagesRemaining - 1);
    const leftRatio = closed ? 0 : leftEdgePages * EDGE_WIDTH_PER_PAGE;
    const rightRatio = closed ? 0 : rightEdgePages * EDGE_WIDTH_PER_PAGE;
    // Display overhang only when open; fit always reserves it so closed/open
    // share the same base face size.
    const overhangX = closed ? 0 : COVER_OVERHANG_RATIO_X;
    const overhangTop = closed ? 0 : COVER_OVERHANG_RATIO_TOP;
    const overhangBottom = closed ? 0 : COVER_OVERHANG_RATIO_BOTTOM;
    const leftStackScale = closed
      ? 1
      : 1 + leftEdgePages * STACK_SCALE_PER_PAGE;
    const rightStackScale = closed
      ? 1
      : 1 + rightEdgePages * STACK_SCALE_PER_PAGE;
    // Mid-book: scaleX → 1 so stacks don't overlap when z-index flips.
    const progressBend = Math.abs(2 * bookProgress - 1);
    const leftScaleX = 1 + (leftStackScale - 1) * progressBend;
    const rightScaleX = 1 + (rightStackScale - 1) * progressBend;
    // Fit against the book's thickest possible stack so base page size
    // stays constant across progress (avoids mid-book "growth").
    const peakStackPages = Math.max(0, pageCount - 2);
    const peakStackScale = 1 + peakStackPages * STACK_SCALE_PER_PAGE;
    const peakEdgeRatio = peakStackPages * EDGE_WIDTH_PER_PAGE;

    const samplePage = await pdf.getPage(samplePageNumber);
    if (token !== renderToken) return;

    const base = samplePage.getViewport({ scale: 1 });
    const aspect = base.height / base.width;
    const stageStyle = getComputedStyle(mustQuery(root, "#spread-stage"));
    const padX =
      Number.parseFloat(stageStyle.paddingLeft) +
      Number.parseFloat(stageStyle.paddingRight);
    const padY =
      Number.parseFloat(stageStyle.paddingTop) +
      Number.parseFloat(stageStyle.paddingBottom);
    const availW = spreadEl.clientWidth - padX;
    const availH = spreadEl.clientHeight - padY;
    if (availW < 1 || availH < 1) return;

    // Always fit as an open spread (2 faces + peak edge + overhang + peak
    // stack height) so opening/closing doesn't change the base face size.
    const widthFromViewport =
      availW / (2 + peakEdgeRatio + 2 * COVER_OVERHANG_RATIO_X);
    const heightFromViewport =
      availH /
      (aspect * peakStackScale +
        COVER_OVERHANG_RATIO_TOP +
        COVER_OVERHANG_RATIO_BOTTOM);
    const cssWidth = Math.floor(
      Math.min(widthFromViewport, heightFromViewport) * zoom
    );
    const cssHeight = Math.floor(cssWidth * aspect);
    if (cssWidth < 1 || cssHeight < 1) return;
    const epoch = syncRasterLayout(cssWidth, cssHeight);

    // Closed cover board = open hardcover half (base face + outer overhang).
    const coverFaceW = Math.max(
      1,
      Math.floor(cssWidth * (1 + COVER_OVERHANG_RATIO_X))
    );
    const coverFaceH = Math.max(
      1,
      Math.floor(
        cssHeight +
          cssWidth * (COVER_OVERHANG_RATIO_TOP + COVER_OVERHANG_RATIO_BOTTOM)
      )
    );
    const leftFaceW = closed
      ? coverFaceW
      : Math.max(1, Math.floor(cssWidth * leftScaleX));
    const leftFaceH = closed
      ? coverFaceH
      : Math.max(1, Math.floor(cssHeight * leftStackScale));
    const rightFaceW = closed
      ? coverFaceW
      : Math.max(1, Math.floor(cssWidth * rightScaleX));
    const rightFaceH = closed
      ? coverFaceH
      : Math.max(1, Math.floor(cssHeight * rightStackScale));

    const overhangXPx = `${cssWidth * overhangX}px`;
    const overhangTopPx = `${cssWidth * overhangTop}px`;
    const overhangBottomPx = `${cssWidth * overhangBottom}px`;
    // Extra width beyond the base face+edge footprint; pulled back on the spine side.
    const leftOverlapX = `${cssWidth * (leftScaleX - 1) * (1 + leftRatio)}px`;
    const rightOverlapX = `${cssWidth * (rightScaleX - 1) * (1 + rightRatio)}px`;

    // Ratio only depends on reading position; face width updates on resize/zoom
    // and CSS keeps edge/cover thickness proportional.
    leftBtn.style.setProperty("--edge-ratio", String(leftRatio));
    rightBtn.style.setProperty("--edge-ratio", String(rightRatio));
    // 0–1 shade for page-stack shadows (1 ≈ thick side stack).
    const stackShadeFull = 0.06;
    leftStack.style.setProperty(
      "--stack-shade",
      String(Math.min(1, leftRatio / stackShadeFull))
    );
    rightStack.style.setProperty(
      "--stack-shade",
      String(Math.min(1, rightRatio / stackShadeFull))
    );
    leftStack.style.setProperty("--stack-scale", String(leftStackScale));
    rightStack.style.setProperty("--stack-scale", String(rightStackScale));
    leftStack.style.setProperty("--scale-x", String(leftScaleX));
    rightStack.style.setProperty("--scale-x", String(rightScaleX));
    // Thicker side paints above the other where scaled stacks overlap.
    if (closed) {
      leftBtn.style.zIndex = "";
      rightBtn.style.zIndex = "";
      leftStack.style.removeProperty("--stack-margin-top");
      leftStack.style.removeProperty("--stack-margin-bottom");
      leftStack.style.removeProperty("--stack-margin-start");
      leftStack.style.removeProperty("--stack-margin-end");
      rightStack.style.removeProperty("--stack-margin-top");
      rightStack.style.removeProperty("--stack-margin-bottom");
      rightStack.style.removeProperty("--stack-margin-start");
      rightStack.style.removeProperty("--stack-margin-end");
    } else if (pagesRead > pagesRemaining) {
      leftBtn.style.zIndex = "2";
      rightBtn.style.zIndex = "1";
    } else if (pagesRemaining > pagesRead) {
      leftBtn.style.zIndex = "1";
      rightBtn.style.zIndex = "2";
    } else {
      leftBtn.style.zIndex = "";
      rightBtn.style.zIndex = "";
    }
    if (!closed) {
      leftStack.style.setProperty("--stack-margin-top", overhangTopPx);
      leftStack.style.setProperty("--stack-margin-bottom", overhangBottomPx);
      leftStack.style.setProperty("--stack-margin-start", overhangXPx);
      leftStack.style.setProperty("--stack-margin-end", `-${leftOverlapX}`);
      rightStack.style.setProperty("--stack-margin-top", overhangTopPx);
      rightStack.style.setProperty("--stack-margin-bottom", overhangBottomPx);
      rightStack.style.setProperty("--stack-margin-start", overhangXPx);
      rightStack.style.setProperty("--stack-margin-end", `-${rightOverlapX}`);
    }
    leftBtn.style.setProperty("--page-face-width", `${leftFaceW}px`);
    rightBtn.style.setProperty("--page-face-width", `${rightFaceW}px`);
    bookEl.style.setProperty("--page-face-width", `${cssWidth}px`);
    bookEl.style.setProperty("--page-face-height", `${cssHeight}px`);
    bookEl.style.setProperty("--cover-overhang-top", overhangTopPx);
    bookEl.style.setProperty("--cover-overhang-bottom", overhangBottomPx);

    // Drop CSS preview before swapping in the new raster size so we don't
    // compound transform scale with the larger layout box.
    bookEl.style.transform = "";
    bookEl.classList.remove("is-preview-zoom");
    zoomShell.style.width = "";
    zoomShell.style.height = "";

    // Always pin face size so zoomed pages can't flex-shrink and overlap.
    sizeFace(leftFace, leftFaceW, leftFaceH);
    sizeFace(rightFace, rightFaceW, rightFaceH);
    randomizePaperPosition(leftFace, left);
    randomizePaperPosition(rightFace, right);

    await Promise.all([
      left !== null
        ? renderPage(
            pdf,
            left,
            leftCanvas,
            leftText,
            leftFaceW,
            leftFaceH,
            token
          )
        : clearPage(leftCanvas, leftText),
      right !== null
        ? renderPage(
            pdf,
            right,
            rightCanvas,
            rightText,
            rightFaceW,
            rightFaceH,
            token
          )
        : clearPage(rightCanvas, rightText),
    ]);

    if (token !== renderToken) return;

    renderedZoom = zoom;
    renderedLayout = {
      w: bookEl.offsetWidth,
      h: bookEl.offsetHeight,
    };
    applyZoomPreview();
    prefetchAdjacent(spread, cssWidth, cssHeight, epoch);
  }

  async function renderPage(
    doc: PDFDocumentProxy,
    pageNumber: number,
    canvas: HTMLCanvasElement,
    textContainer: HTMLElement,
    cssWidth: number,
    cssHeight: number,
    token: number
  ) {
    cancelTextLayer(textContainer);

    const raster = await getRaster(doc, pageNumber, cssWidth, cssHeight, token);
    if (!raster || token !== renderToken) return;

    // Resize clears the bitmap; blit the cached raster in the same turn so
    // cache hits never show a white frame.
    canvas.width = raster.width;
    canvas.height = raster.height;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(raster, 0, 0);

    const page: PDFPageProxy = await doc.getPage(pageNumber);
    if (token !== renderToken) return;

    const base = page.getViewport({ scale: 1 });
    const cssScale = cssWidth / base.width;
    const textViewport = page.getViewport({ scale: cssScale });

    textContainer.hidden = false;
    textContainer.replaceChildren();
    textContainer.style.setProperty("--total-scale-factor", String(cssScale));

    const textLayer = new TextLayer({
      textContentSource: page.streamTextContent({
        includeMarkedContent: true,
      }),
      container: textContainer,
      viewport: textViewport,
    });
    textLayers.set(textContainer, textLayer);
    try {
      await textLayer.render();
      if (token !== renderToken) {
        cancelTextLayer(textContainer);
        textContainer.replaceChildren();
        textContainer.hidden = true;
      }
    } catch {
      if (textLayers.get(textContainer) === textLayer) {
        textLayers.delete(textContainer);
      }
    }
  }

  function clearPage(canvas: HTMLCanvasElement, textContainer: HTMLElement) {
    cancelRender(canvas);
    clearTextLayer(textContainer);
    const context = canvas.getContext("2d");
    if (context) context.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 0;
    canvas.height = 0;
    canvas.style.width = "";
    canvas.style.height = "";
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function sizeFace(face: HTMLElement, width: number, height: number) {
  face.style.width = `${width}px`;
  face.style.height = `${height}px`;
}

/** New paper-texture offset whenever the face shows a different page. */
function randomizePaperPosition(face: HTMLElement, page: number | null) {
  const key = page === null ? "" : String(page);
  if (face.dataset.paperPage === key) return;
  face.dataset.paperPage = key;
  if (page === null) {
    face.style.removeProperty("--paper-position");
    return;
  }
  const x = Math.floor(Math.random() * 100);
  const y = Math.floor(Math.random() * 100);
  face.style.setProperty("--paper-position", `${x}% ${y}%`);
}

function mustQuery(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector(selector);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`Missing element: ${selector}`);
  }
  return el;
}
