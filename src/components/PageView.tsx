import { memo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { MessageKey, Translate } from '../i18n';
import { LINE_HEIGHT, layoutBubble, type BubbleLayout, type LayoutOptions } from '../lib/layout';
import type { Box } from '../lib/text';
import type { Bubble, Page } from '../lib/types';
import { Icon } from './Icon';

const pct = (v: number, total: number) => `${(v / total) * 100}%`;

function outlineShadow(l: BubbleLayout, width: number): string {
  const c = l.color === '#ffffff' ? '#000' : '#fff';
  const d = `${((l.fontSize * 0.08) / width) * 100}cqw`;
  const n = `calc(-1 * ${d})`;
  return [`${d} 0`, `${n} 0`, `0 ${d}`, `0 ${n}`, `${d} ${d}`, `${n} ${n}`, `${d} ${n}`, `${n} ${d}`]
    .map((o) => `${o} 0 ${c}`)
    .join(', ');
}

function TranslatedLayer({
  page,
  bubbles,
  opts,
  selectedId,
  onSelect,
}: {
  page: Page;
  bubbles: Bubble[];
  opts: LayoutOptions;
  selectedId?: string;
  onSelect?: (bubbleId: string) => void;
}) {
  const W = page.width;
  const H = page.height;
  const cq = (v: number) => `${(v / W) * 100}cqw`;
  return (
    <div className="tb-layer">
      {bubbles.map((b) => {
        const l = layoutBubble(b, page, opts);
        if (!l) return null;
        const textStyle: CSSProperties = {
          left: pct(l.area.x, W),
          top: pct(l.area.y, H),
          width: pct(l.area.w, W),
          height: pct(l.area.h, H),
          padding: cq(l.padding),
          fontFamily: l.family,
          fontWeight: l.weight,
          fontSize: cq(l.fontSize),
          lineHeight: LINE_HEIGHT,
          color: l.color,
          textShadow: l.outline ? outlineShadow(l, W) : undefined,
        };
        return (
          <div key={b.id} className={`tb ${selectedId === b.id ? 'selected' : ''}`} onClick={() => onSelect?.(b.id)}>
            <div
              className="tb-erase"
              style={{
                left: pct(l.erase.x, W),
                top: pct(l.erase.y, H),
                width: pct(l.erase.w, W),
                height: pct(l.erase.h, H),
                background: l.fill,
                borderRadius: cq(l.radius),
              }}
            />
            <div className="tb-text" dir={l.rtl ? 'rtl' : 'ltr'} style={textStyle}>
              {l.lines.map((line, i) => (
                <span key={i}>{line}</span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

type Drag =
  | { kind: 'move' | 'resize'; id: string; x0: number; y0: number; orig: Box; moved: boolean }
  | { kind: 'draw'; x0: number; y0: number };

function EditLayer({
  page,
  bubbles,
  drawing,
  busyIds,
  selectedId,
  onSelect,
  onGeometry,
  onCreate,
}: {
  page: Page;
  bubbles: Bubble[];
  drawing: boolean;
  busyIds: string[];
  selectedId?: string;
  onSelect: (bubbleId: string) => void;
  onGeometry: (bubbleId: string, box: Box, resized: boolean) => void;
  onCreate: (box: Box) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<{ id: string | null; box: Box } | null>(null);

  const toImage = (e: { clientX: number; clientY: number }) => {
    const r = layer.current!.getBoundingClientRect();
    return {
      x: Math.min(page.width, Math.max(0, ((e.clientX - r.left) / r.width) * page.width)),
      y: Math.min(page.height, Math.max(0, ((e.clientY - r.top) / r.height) * page.height)),
    };
  };

  const startBox = (e: ReactPointerEvent, b: Bubble, kind: 'move' | 'resize') => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toImage(e);
    drag.current = { kind, id: b.id, x0: p.x, y0: p.y, orig: { x: b.x, y: b.y, w: b.w, h: b.h }, moved: false };
  };

  const onLayerDown = (e: ReactPointerEvent) => {
    if (!drawing) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toImage(e);
    drag.current = { kind: 'draw', x0: p.x, y0: p.y };
    setPreview({ id: null, box: { x: p.x, y: p.y, w: 0, h: 0 } });
  };

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toImage(e);
    if (d.kind === 'draw') {
      setPreview({
        id: null,
        box: { x: Math.min(d.x0, p.x), y: Math.min(d.y0, p.y), w: Math.abs(p.x - d.x0), h: Math.abs(p.y - d.y0) },
      });
      return;
    }
    const dx = p.x - d.x0;
    const dy = p.y - d.y0;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    const box =
      d.kind === 'move'
        ? { ...d.orig, x: d.orig.x + dx, y: d.orig.y + dy }
        : { ...d.orig, w: Math.max(12, d.orig.w + dx), h: Math.max(12, d.orig.h + dy) };
    setPreview({ id: d.id, box });
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'draw') {
      if (preview && preview.box.w > 10 && preview.box.h > 10) onCreate(preview.box);
    } else if (!d.moved) {
      onSelect(d.id);
    } else if (preview?.id === d.id) {
      onGeometry(d.id, preview.box, d.kind === 'resize');
    }
    setPreview(null);
  };

  return (
    <div
      ref={layer}
      className={`edit-layer ${drawing ? 'drawing' : ''}`}
      onPointerDown={onLayerDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => {
        drag.current = null;
        setPreview(null);
      }}
    >
      {bubbles.map((b, i) => {
        const box = preview?.id === b.id ? preview.box : b;
        return (
          <div
            key={b.id}
            className={`eb ${selectedId === b.id ? 'selected' : ''} ${busyIds.includes(b.id) ? 'busy' : ''} ${
              b.hidden ? 'muted' : ''
            }`}
            style={{ left: pct(box.x, page.width), top: pct(box.y, page.height), width: pct(box.w, page.width), height: pct(box.h, page.height) }}
            onPointerDown={(e) => startBox(e, b, 'move')}
            onPointerMove={onMove}
            onPointerUp={onUp}
          >
            <span className="eb-num">{i + 1}</span>
            <span className="eb-handle" onPointerDown={(e) => startBox(e, b, 'resize')} onPointerMove={onMove} onPointerUp={onUp} />
          </div>
        );
      })}
      {preview && preview.id === null && (
        <div
          className="eb drawing"
          style={{
            left: pct(preview.box.x, page.width),
            top: pct(preview.box.y, page.height),
            width: pct(preview.box.w, page.width),
            height: pct(preview.box.h, page.height),
          }}
        />
      )}
    </div>
  );
}

export interface PageViewProps {
  page: Page;
  url: string;
  showTranslation: boolean;
  interactive: boolean;
  editing: boolean;
  drawing: boolean;
  opts: LayoutOptions;
  fontsOk: boolean;
  draft: Bubble | null;
  selectedId?: string;
  busyIds: string[];
  t: Translate;
  onSelect: (pageId: string, bubbleId: string) => void;
  onGeometry: (pageId: string, bubbleId: string, box: Box, resized: boolean) => void;
  onCreate: (pageId: string, box: Box) => void;
  onRetry: (pageId: string) => void;
}

const STATUS_KEY: Record<string, MessageKey> = {
  pending: 'reader.page.pending',
  ocr: 'reader.page.ocr',
  translating: 'reader.page.translating',
  error: 'reader.page.error',
};

function PageViewImpl(props: PageViewProps) {
  const { page, url, showTranslation, interactive, editing, drawing, opts, fontsOk, draft, selectedId, busyIds, t } = props;
  const bubbles = draft ? page.bubbles.map((b) => (b.id === draft.id ? draft : b)) : page.bubbles;
  const working = page.status === 'ocr' || page.status === 'translating';
  return (
    <div className={`page ${working ? 'working' : ''}`} id={`page-${page.index}`} style={{ aspectRatio: `${page.width} / ${page.height}` }}>
      <img src={url} alt="" width={page.width} height={page.height} loading="lazy" decoding="async" draggable={false} />
      {showTranslation && fontsOk && (
        <TranslatedLayer
          page={page}
          bubbles={bubbles}
          opts={opts}
          selectedId={selectedId}
          onSelect={interactive && !editing ? (id) => props.onSelect(page.id, id) : undefined}
        />
      )}
      {interactive && editing && (
        <EditLayer
          page={page}
          bubbles={bubbles}
          drawing={drawing}
          busyIds={busyIds}
          selectedId={selectedId}
          onSelect={(id) => props.onSelect(page.id, id)}
          onGeometry={(id, box, resized) => props.onGeometry(page.id, id, box, resized)}
          onCreate={(box) => props.onCreate(page.id, box)}
        />
      )}
      {working && <div className="scanline" aria-hidden="true" />}
      {interactive && page.status !== 'done' && (
        <div className={`page-chip ${page.status}`}>
          <span>{t(STATUS_KEY[page.status])}</span>
          {page.status === 'error' && (
            <>
              {page.error && <small title={page.error}>{page.error.slice(0, 120)}</small>}
              <button className="btn small" onClick={() => props.onRetry(page.id)}>
                <Icon name="refresh" size={14} /> {t('reader.page.retry')}
              </button>
            </>
          )}
        </div>
      )}
      {interactive && editing && page.status === 'done' && page.bubbles.length === 0 && (
        <div className="page-chip">
          <span>{t('reader.page.noText')}</span>
        </div>
      )}
    </div>
  );
}

export const PageView = memo(PageViewImpl, (a, b) => {
  return (
    a.page.id === b.page.id &&
    a.page.rev === b.page.rev &&
    a.page.status === b.page.status &&
    a.url === b.url &&
    a.showTranslation === b.showTranslation &&
    a.interactive === b.interactive &&
    a.editing === b.editing &&
    a.drawing === b.drawing &&
    a.fontsOk === b.fontsOk &&
    a.draft === b.draft &&
    a.selectedId === b.selectedId &&
    a.busyIds.join() === b.busyIds.join() &&
    a.opts.font === b.opts.font &&
    a.opts.uppercase === b.opts.uppercase &&
    a.opts.target === b.opts.target &&
    a.t === b.t
  );
});
