/**
 * Barcode scanner input (PRD §10, §28, §29).
 *
 * WHY THIS IS NOT TRIVIAL
 * -----------------------
 * The overwhelming majority of shop scanners are "keyboard wedge" devices: they
 * literally type the barcode into whatever field has focus and press Enter. That
 * makes them universal and it makes them easy to break:
 *
 *   - A cashier typing a product search at 8 characters/second looks EXACTLY like
 *     a scanner, unless we measure inter-keystroke timing. We do.
 *   - Cheap scanners sometimes emit the code with no terminator, or with a stray
 *     prefix/suffix. We handle both.
 *   - A scanner can double-fire (physical bounce, or a trigger held down). We
 *     debounce identical codes inside a short window (PRD §46 "duplicate barcode
 *     scanned rapidly").
 *   - A scanner must work while the cart has focus, while a modal is open, and
 *     while a number pad is open. So the listener is global and the handler
 *     decides what to do with the scan.
 *
 * The rule that keeps this predictable: a scan is recognised by TIMING, not by
 * content. Fast + terminated = scanner. Anything else is typing, and typing is
 * never stolen from a text field.
 */

import { analyseBarcode, type BarcodeAnalysis } from '@/domain/barcode';

/** A run of keystrokes faster than this (ms apart) is machine input, not a human. */
export const SCANNER_MAX_KEY_GAP_MS = 55;
/** Scanner codes are terminated by Enter. Give up on a run longer than this. */
export const SCANNER_BUFFER_TIMEOUT_MS = 120;
/** Minimum plausible barcode length — below this it is almost certainly typing. */
export const SCANNER_MIN_LENGTH = 4;
/** Identical codes inside this window are treated as one scan (debounce). */
export const SCANNER_DUPLICATE_WINDOW_MS = 700;

export interface ScanEvent {
  analysis: BarcodeAnalysis;
  /** Monotonic scan counter, for the "scan #42" style feedback. */
  sequence: number;
  receivedAt: string;
  /** Set when this scan matched an earlier one inside the debounce window. */
  duplicate: boolean;
  /** Where the scan came from, so we can attribute scanner-vs-camera analytics. */
  source: 'hid' | 'camera' | 'manual';
}

export interface ScannerOptions {
  onScan: (event: ScanEvent) => void;
  /**
   * Return false to let the keystroke through to the focused field. Used so a
   * cashier can still type into the search box.
   */
  shouldCapture?: (context: { bufferLength: number; target: EventTarget | null }) => boolean;
  maxKeyGapMs?: number;
  duplicateWindowMs?: number;
}

interface KeyboardLikeEvent {
  key?: string | number | undefined;
  timeStamp?: number;
  target?: EventTarget | null;
  preventDefault?: () => void;
  stopPropagation?: () => void;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

export class ScannerListener {
  private buffer = '';
  private lastKeyAt = 0;
  private lastEmitAt = 0;
  private lastCode = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers: Array<{ target: EventTarget; type: string; handler: EventListener }> = [];
  private started = false;
  private scanSequence = 0;

  constructor(private readonly options: ScannerOptions) {}

  get isRunning(): boolean {
    return this.started;
  }

  /** Attach to a target (default: the document/global object). */
  start(target?: EventTarget): void {
    if (this.started) return;
    const host: EventTarget =
      target ??
      (typeof globalThis !== 'undefined' && (globalThis as { document?: EventTarget }).document
        ? ((globalThis as unknown as { document: EventTarget }).document)
        : (globalThis as unknown as EventTarget));

    const keydown = ((event: Event) => this.handleKeyDown(event as unknown as KeyboardLikeEvent)) as EventListener;
    const blur = (() => this.reset()) as EventListener;

    host.addEventListener?.('keydown', keydown, true);
    host.addEventListener?.('blur', blur, true);
    this.handlers.push({ target: host, type: 'keydown', handler: keydown });
    this.handlers.push({ target: host, type: 'blur', handler: blur });
    this.started = true;
  }

  stop(): void {
    for (const { target, type, handler } of this.handlers) {
      target.removeEventListener?.(type, handler, true);
    }
    this.handlers = [];
    this.reset();
    this.started = false;
  }

  private reset(): void {
    this.buffer = '';
    this.lastKeyAt = 0;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private handleKeyDown(event: KeyboardLikeEvent): void {
    try {
      this._handleKeyDownInner(event);
    } catch {
      // Swallow — a broken event must never crash the POS terminal.
      this.reset();
    }
  }

  private _handleKeyDownInner(event: KeyboardLikeEvent): void {
    // Guard: some dispatched events (composition, React Native synthetic, etc.)
    // arrive without a proper `key` string.  `typeof` is the only accessor that
    // can never throw, so use it as the very first check.
    const key = event?.key;
    if (typeof key !== 'string' || key === '') {
      this.reset();
      return;
    }

    // Never interfere with shortcuts.
    if (event.ctrlKey || event.altKey || event.metaKey) {
      this.reset();
      return;
    }

    const now = typeof event.timeStamp === 'number' && event.timeStamp > 0 ? event.timeStamp : Date.now();
    const gap = this.lastKeyAt === 0 ? 0 : now - this.lastKeyAt;
    const maxGap = this.options.maxKeyGapMs ?? SCANNER_MAX_KEY_GAP_MS;

    // A gap longer than the threshold means a human typed it, not a scanner.
    if (gap > maxGap && this.buffer.length > 0) this.buffer = '';

    if (key === 'Enter' || key === 'Tab') {
      if (this.buffer.length >= SCANNER_MIN_LENGTH) {
        const consumed = this.emit(this.buffer, 'hid');
        if (consumed) {
          event.preventDefault?.();
          event.stopPropagation?.();
        }
      } else if (key === 'Tab') {
        // Never eat Tab: cashiers use it to move between fields.
        this.reset();
        return;
      }
      this.reset();
      return;
    }

    // Ignore modifier-ish and navigation keys outright.
    if (key.length !== 1) {
      if (key === 'Backspace') {
        this.buffer = this.buffer.slice(0, -1);
        this.lastKeyAt = now;
        return;
      }
      this.reset();
      return;
    }

    this.buffer += key;
    this.lastKeyAt = now;

    // Some scanners are configured with NO terminator. If the run stops growing,
    // treat it as a scan rather than silently discarding the keystrokes.
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      if (this.buffer.length >= SCANNER_MIN_LENGTH && Date.now() - this.lastKeyAt >= (this.options.maxKeyGapMs ?? SCANNER_MAX_KEY_GAP_MS)) {
        this.emit(this.buffer, 'hid');
      }
      this.buffer = '';
      this.flushTimer = null;
    }, SCANNER_BUFFER_TIMEOUT_MS);

    // Once we are clearly inside a machine-speed run, prevent the characters from
    // polluting whatever input happens to be focused.
    if (this.buffer.length >= SCANNER_MIN_LENGTH && this.shouldCapture(event.target)) {
      event.preventDefault?.();
    }
  }

  private shouldCapture(target: EventTarget | null | undefined): boolean {
    return this.options.shouldCapture?.({ bufferLength: this.buffer.length, target: target ?? null }) ?? true;
  }

  /** Feed a code from the camera or a manual entry through the same pipeline. */
  emit(raw: string, source: ScanEvent['source']): boolean {
    const now = Date.now();
    const analysis = analyseBarcode(raw);
    if (!analysis.value) return false;

    const duplicate =
      analysis.value === this.lastCode && now - this.lastEmitAt < (this.options.duplicateWindowMs ?? SCANNER_DUPLICATE_WINDOW_MS);

    this.scanSequence += 1;
    const event: ScanEvent = {
      analysis,
      sequence: this.scanSequence,
      receivedAt: new Date(now).toISOString(),
      duplicate,
      source,
    };

    // Still report the duplicate — the UI should say "already scanned" rather
    // than appear to ignore the operator — but flag it so the cart does not
    // silently double the quantity.
    this.lastCode = analysis.value;
    this.lastEmitAt = now;
    this.options.onScan(event);
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Cart-add policy                                                     */
/* ------------------------------------------------------------------ */

/**
 * Should a scan add another unit, or should the cashier be asked?
 *
 * The rule: a duplicate INSIDE the debounce window is a physical double-read and
 * is ignored. A deliberate re-scan later is a real second unit. That distinction
 * is what stops "one box of milk became two" at the till while still letting a
 * cashier scan the same item three times on purpose.
 */
export function shouldAddToCart(event: ScanEvent): boolean {
  return !event.duplicate;
}

export const SCANNER_HELP = {
  success: 'Item added',
  duplicate: 'Already scanned — quantity unchanged',
  unknown: 'No product matches this barcode',
  blocked: 'This item cannot be sold',
  implausible: 'This looks like a damaged barcode',
};
