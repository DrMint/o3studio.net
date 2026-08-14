import {
  getDocument,
  GlobalWorkerOptions,
  RenderingCancelledException,
  TextLayer,
} from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

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

const SCRUB_DEBOUNCE_MS = 80;

export async function initBookReader(root: HTMLElement): Promise<void> {
  const pdfUrl = root.dataset.pdfUrl;
  if (!pdfUrl) throw new Error("Missing data-pdf-url");

  const spreadEl = mustQuery(root, "#spread");
  const bookEl = mustQuery(root, "#book");
  const leftBtn = mustQuery(root, "[data-page='left']");
  const rightBtn = mustQuery(root, "[data-page='right']");
  const leftFace = mustQuery(leftBtn, ".page-face");
  const rightFace = mustQuery(rightBtn, ".page-face");
  const leftCanvas = mustQuery(leftBtn, "canvas") as HTMLCanvasElement;
  const rightCanvas = mustQuery(rightBtn, "canvas") as HTMLCanvasElement;
  const leftText = mustQuery(leftBtn, ".textLayer");
  const rightText = mustQuery(rightBtn, ".textLayer");
  const pageInput = mustQuery(root, "[data-page-input]") as HTMLInputElement;
  const pageSlider = mustQuery(root, "[data-page-slider]") as HTMLInputElement;
  const pageCountLabel = mustQuery(root, "[data-page-count]");

  const pdf = await getDocument({ url: pdfUrl }).promise;
  const pageCount = pdf.numPages;
  let spread = 0;
  let renderToken = 0;
  let scrubTimer: ReturnType<typeof setTimeout> | undefined;
  const renderTasks = new Map<HTMLCanvasElement, RenderTask>();
  const textLayers = new Map<HTMLElement, TextLayer>();

  pageInput.max = String(pageCount);
  pageSlider.max = String(pageCount);
  pageCountLabel.textContent = `/ ${pageCount}`;

  bindPageTurn(leftBtn, () => {
    if (spread <= 0) return;
    spread -= 1;
    void showSpread();
  });

  bindPageTurn(rightBtn, () => {
    if (spread >= maxSpread(pageCount)) return;
    spread += 1;
    void showSpread();
  });

  pageSlider.addEventListener("input", () => {
    scheduleScrub(Number(pageSlider.value));
  });

  pageSlider.addEventListener("change", () => {
    flushScrub(Number(pageSlider.value));
  });

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

  window.addEventListener("resize", () => void showSpread());

  await showSpread();

  function displayedPage(): number {
    const { left, right } = pagesForSpread(spread, pageCount);
    return left ?? right ?? 1;
  }

  function scheduleScrub(page: number) {
    if (!Number.isFinite(page)) return;
    spread = spreadForPage(clamp(Math.round(page), 1, pageCount));
    pageInput.value = String(displayedPage());
    window.clearTimeout(scrubTimer);
    scrubTimer = setTimeout(() => {
      scrubTimer = undefined;
      void showSpread();
    }, SCRUB_DEBOUNCE_MS);
  }

  function flushScrub(page: number) {
    window.clearTimeout(scrubTimer);
    scrubTimer = undefined;
    if (!Number.isFinite(page)) return;
    spread = spreadForPage(clamp(Math.round(page), 1, pageCount));
    void showSpread();
  }

  function goSpread(delta: number) {
    window.clearTimeout(scrubTimer);
    scrubTimer = undefined;
    const next = clamp(spread + delta, 0, maxSpread(pageCount));
    if (next === spread) {
      syncPager();
      return;
    }
    spread = next;
    void showSpread();
  }

  function goToPage(page: number) {
    window.clearTimeout(scrubTimer);
    scrubTimer = undefined;
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
    pageSlider.value = String(currentPage);
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

  async function showSpread() {
    const token = ++renderToken;
    const { left, right } = pagesForSpread(spread, pageCount);
    const canPrev = spread > 0;
    const canNext = spread < maxSpread(pageCount);
    const samplePageNumber = left ?? right;
    if (samplePageNumber === null) return;

    leftBtn.dataset.empty = String(left === null);
    rightBtn.dataset.empty = String(right === null);
    leftBtn.dataset.active = String(left !== null && canPrev);
    rightBtn.dataset.active = String(right !== null && canNext);
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
    const maxEdge = Math.min(40, (spreadEl.clientWidth / 2) * 0.14);
    const edgeScale = maxEdge / Math.max(pageCount - 1, 1);
    const leftEdge = closed ? 0 : edgeScale * pagesRead;
    const rightEdge = closed ? 0 : edgeScale * pagesRemaining;

    leftBtn.style.setProperty("--edge-width", `${leftEdge}px`);
    rightBtn.style.setProperty("--edge-width", `${rightEdge}px`);

    const samplePage = await pdf.getPage(samplePageNumber);
    if (token !== renderToken) return;

    const base = samplePage.getViewport({ scale: 1 });
    const maxWidth = (spreadEl.clientWidth - leftEdge - rightEdge) / 2;
    const maxHeight = spreadEl.clientHeight;
    if (maxWidth < 1 || maxHeight < 1) return;

    const fit = Math.min(maxWidth / base.width, maxHeight / base.height);
    const cssWidth = Math.floor(base.width * fit);
    const cssHeight = Math.floor(base.height * fit);

    sizeFace(leftFace, left === null ? cssWidth : null, cssHeight);
    sizeFace(rightFace, right === null ? cssWidth : null, cssHeight);

    await Promise.all([
      left !== null
        ? renderPage(pdf, left, leftCanvas, leftText, cssWidth, cssHeight, token)
        : clearPage(leftCanvas, leftText),
      right !== null
        ? renderPage(
            pdf,
            right,
            rightCanvas,
            rightText,
            cssWidth,
            cssHeight,
            token,
          )
        : clearPage(rightCanvas, rightText),
    ]);
  }

  async function renderPage(
    doc: PDFDocumentProxy,
    pageNumber: number,
    canvas: HTMLCanvasElement,
    textContainer: HTMLElement,
    cssWidth: number,
    cssHeight: number,
    token: number,
  ) {
    // Always cancel before touching the canvas — overlapping pdf.js draws
    // corrupt size/orientation when scrubbing quickly.
    cancelRender(canvas);
    cancelTextLayer(textContainer);

    const page: PDFPageProxy = await doc.getPage(pageNumber);
    if (token !== renderToken) return;

    cancelRender(canvas);
    cancelTextLayer(textContainer);
    if (token !== renderToken) return;

    const base = page.getViewport({ scale: 1 });
    const cssScale = cssWidth / base.width;
    const outputScale = window.devicePixelRatio || 1;
    const canvasViewport = page.getViewport({
      scale: cssScale * outputScale,
    });
    const textViewport = page.getViewport({ scale: cssScale });

    canvas.width = Math.floor(canvasViewport.width);
    canvas.height = Math.floor(canvasViewport.height);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const context = canvas.getContext("2d");
    if (!context) return;

    const task = page.render({
      canvas,
      canvasContext: context,
      viewport: canvasViewport,
    });
    renderTasks.set(canvas, task);
    try {
      await task.promise;
    } catch (error) {
      if (error instanceof RenderingCancelledException) return;
      throw error;
    } finally {
      if (renderTasks.get(canvas) === task) renderTasks.delete(canvas);
    }

    if (token !== renderToken) return;

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

function bindPageTurn(pageEl: HTMLElement, turn: () => void) {
  pageEl.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // Clicks on PDF text spans are for selection/copy, not page turns.
    if (target.closest(".textLayer :is(span, br)")) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && pageEl.contains(selection.anchorNode)) {
      return;
    }
    turn();
  });

  pageEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    turn();
  });
}

function sizeFace(face: HTMLElement, width: number | null, height: number) {
  face.style.width = width === null ? "" : `${width}px`;
  face.style.height = width === null ? "" : `${height}px`;
}

function mustQuery(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector(selector);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`Missing element: ${selector}`);
  }
  return el;
}
