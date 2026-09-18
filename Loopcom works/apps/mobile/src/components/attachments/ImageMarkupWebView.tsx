import React, { useMemo, useRef } from 'react'
import { Alert, StyleSheet, View } from 'react-native'
import { WebView, WebViewMessageEvent } from 'react-native-webview'
import { saveMarkupAsAttachmentCopy, shareDataUrl } from '../../services/open-attachment'

type Props = {
  src: string
  fileName: string
  active: boolean
  entityType?: 'job' | 'request' | 'task' | 'issue' | string
  entityId?: string
  onSavedCopy?: () => void
}

function buildMarkupHtml(src: string, fileName: string) {
  const safeSrc = JSON.stringify(src)
  const safeName = JSON.stringify(fileName)
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body { margin:0; padding:0; width:100%; height:100%; background:#000; color:#fff; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; overflow:hidden; }
  #root { display:flex; flex-direction:column; height:100%; }
  #toolbar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:8px; border-bottom:1px solid rgba(255,255,255,.12); background:#111; }
  button { appearance:none; border:0; border-radius:8px; padding:7px 10px; background:rgba(255,255,255,.12); color:#fff; font-size:12px; font-weight:600; }
  button.active { background:#fff; color:#111; }
  button:disabled { opacity:.4; }
  .swatch { width:22px; height:22px; border-radius:999px; border:2px solid rgba(255,255,255,.35); padding:0; }
  .swatch.active { border-color:#fff; box-shadow:0 0 0 2px rgba(255,255,255,.35); }
  #stage { position:relative; flex:1; min-height:0; overflow:hidden; background:#000; }
  canvas { width:100%; height:100%; touch-action:none; display:block; }
  #textInput { position:absolute; z-index:5; min-width:160px; padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.35); background:rgba(17,17,17,.95); color:#fff; font-size:14px; outline:none; display:none; }
  #zoomLabel { min-width:44px; text-align:center; font-size:12px; color:#d4d4d8; }
  label.size { display:flex; align-items:center; gap:6px; font-size:12px; color:#d4d4d8; }
</style>
</head>
<body>
<div id="root">
  <div id="toolbar">
    <button type="button" id="zoomIn">+</button>
    <button type="button" id="zoomOut">−</button>
    <span id="zoomLabel">100%</span>
    <button type="button" id="resetZoom">Reset</button>
    <button type="button" class="tool active" data-tool="pan">Pan</button>
    <button type="button" class="tool" data-tool="select">Select</button>
    <button type="button" class="tool" data-tool="pen">Pen</button>
    <button type="button" class="tool" data-tool="arrow">Arrow</button>
    <button type="button" class="tool" data-tool="box">Box</button>
    <button type="button" class="tool" data-tool="text">Text</button>
    <span id="colors"></span>
    <label class="size">Size <input id="brush" type="range" min="2" max="16" value="4" /></label>
    <button type="button" id="undo">Undo</button>
    <button type="button" id="clear">Clear</button>
    <button type="button" id="save">Save</button>
  </div>
  <div id="stage">
    <canvas id="canvas"></canvas>
    <input id="textInput" placeholder="Type text…" />
  </div>
</div>
<script>
(function () {
  const SRC = ${safeSrc};
  const FILE_NAME = ${safeName};
  const COLORS = ['#ef4444','#f59e0b','#22c55e','#3b82f6','#ffffff','#111827'];
  const HIT_PAD = 14;
  const HANDLE_RADIUS = 16;
  const canvas = document.getElementById('canvas');
  const stage = document.getElementById('stage');
  const textInput = document.getElementById('textInput');
  const zoomLabel = document.getElementById('zoomLabel');
  const colorsEl = document.getElementById('colors');
  const brushEl = document.getElementById('brush');
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = SRC;

  let zoom = 1, offset = { x: 0, y: 0 }, tool = 'pan', color = COLORS[0], brush = 4;
  let items = [], draft = null, drawing = false, panning = false;
  let panStart = { x: 0, y: 0, ox: 0, oy: 0 };
  let pendingText = null;
  let selectedId = null;
  let dragMode = null; // 'move' | 'start' | 'end'
  let draggingSelect = false;
  let dragOrigin = null;
  let dragStartClient = { x: 0, y: 0 };

  COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (c === color ? ' active' : '');
    b.style.background = c;
    b.onclick = () => {
      color = c;
      Array.from(colorsEl.children).forEach((el) => el.classList.toggle('active', el === b));
    };
    colorsEl.appendChild(b);
  });

  function post(payload) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  }

  function project(point, origin, fit, z) {
    return { x: origin.x + point.x * fit * z, y: origin.y + point.y * fit * z };
  }

  function drawArrow(ctx, from, to, strokeColor, lineWidth) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const headLen = Math.max(10, lineWidth * 3.2);
    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - headLen * Math.cos(angle - Math.PI / 6), to.y - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(to.x - headLen * Math.cos(angle + Math.PI / 6), to.y - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  function metrics() {
    const rect = stage.getBoundingClientRect();
    const naturalW = image.naturalWidth || 1;
    const naturalH = image.naturalHeight || 1;
    const fit = Math.min(rect.width / naturalW, rect.height / naturalH);
    const drawW = naturalW * fit * zoom;
    const drawH = naturalH * fit * zoom;
    const origin = {
      x: (rect.width - drawW) / 2 + offset.x,
      y: (rect.height - drawH) / 2 + offset.y,
    };
    return { rect, fit, origin, naturalW, naturalH, drawW, drawH };
  }

  function boxBoundsScreen(item, m) {
    const a = project(item.start, m.origin, m.fit, zoom);
    const b = project(item.end, m.origin, m.fit, zoom);
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  function textBoundsScreen(item, m) {
    const at = project(item.point, m.origin, m.fit, zoom);
    const fontSize = Math.max(10, item.size * zoom);
    const ctx = canvas.getContext('2d');
    ctx.font = '700 ' + fontSize + 'px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
    const width = ctx.measureText(item.text).width;
    return { x: at.x, y: at.y, w: width, h: fontSize };
  }

  function pointInRect(pt, rect, pad) {
    return (
      pt.x >= rect.x - pad &&
      pt.x <= rect.x + rect.w + pad &&
      pt.y >= rect.y - pad &&
      pt.y <= rect.y + rect.h + pad
    );
  }

  function distanceToSegment(pt, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq)) : 0;
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    return Math.hypot(pt.x - projX, pt.y - projY);
  }

  function hitTest(screenPt) {
    const m = metrics();
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === 'box') {
        if (pointInRect(screenPt, boxBoundsScreen(item, m), HIT_PAD)) return item;
      } else if (item.type === 'text') {
        if (pointInRect(screenPt, textBoundsScreen(item, m), HIT_PAD)) return item;
      } else if (item.type === 'arrow') {
        const a = project(item.start, m.origin, m.fit, zoom);
        const b = project(item.end, m.origin, m.fit, zoom);
        if (distanceToSegment(screenPt, a, b) <= HIT_PAD) return item;
      }
    }
    return null;
  }

  function renderItem(ctx, item, origin, fit, z) {
    if (item.type === 'pen') {
      if (item.points.length < 2) return;
      ctx.strokeStyle = item.color;
      ctx.lineWidth = item.width * z;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const first = project(item.points[0], origin, fit, z);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < item.points.length; i++) {
        const p = project(item.points[i], origin, fit, z);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      return;
    }
    if (item.type === 'arrow') {
      drawArrow(ctx, project(item.start, origin, fit, z), project(item.end, origin, fit, z), item.color, item.width * z);
      return;
    }
    if (item.type === 'box') {
      const a = project(item.start, origin, fit, z);
      const b = project(item.end, origin, fit, z);
      ctx.strokeStyle = item.color;
      ctx.lineWidth = item.width * z;
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      return;
    }
    if (item.type === 'text') {
      const at = project(item.point, origin, fit, z);
      const fontSize = Math.max(10, item.size * z);
      ctx.fillStyle = item.color;
      ctx.font = '700 ' + fontSize + 'px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
      ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 2;
      ctx.fillText(item.text, at.x, at.y);
      ctx.shadowBlur = 0;
    }
  }

  function renderSelectionHighlight(ctx, item, m) {
    const PAD = 6;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#38bdf8';
    if (item.type === 'box') {
      const r = boxBoundsScreen(item, m);
      ctx.strokeRect(r.x - PAD, r.y - PAD, r.w + PAD * 2, r.h + PAD * 2);
    } else if (item.type === 'text') {
      const r = textBoundsScreen(item, m);
      ctx.strokeRect(r.x - PAD, r.y - PAD, r.w + PAD * 2, r.h + PAD * 2);
    } else if (item.type === 'arrow') {
      const a = project(item.start, m.origin, m.fit, zoom);
      const b = project(item.end, m.origin, m.fit, zoom);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#38bdf8';
      [a, b].forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    ctx.restore();
  }

  function redraw() {
    if (!image.complete) return;
    const m = metrics();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(m.rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(m.rect.height * dpr));
    canvas.style.width = m.rect.width + 'px';
    canvas.style.height = m.rect.height + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, m.rect.width, m.rect.height);
    ctx.drawImage(image, m.origin.x, m.origin.y, m.drawW, m.drawH);
    items.forEach((item) => renderItem(ctx, item, m.origin, m.fit, zoom));
    if (draft) renderItem(ctx, draft, m.origin, m.fit, zoom);
    if (tool === 'select' && selectedId) {
      const selected = items.find((it) => it.id === selectedId);
      if (selected) renderSelectionHighlight(ctx, selected, m);
    }
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
    document.getElementById('undo').disabled = items.length === 0;
    document.getElementById('clear').disabled = items.length === 0;
  }

  function imagePoint(clientX, clientY) {
    const m = metrics();
    return {
      x: (clientX - m.rect.left - m.origin.x) / (m.fit * zoom),
      y: (clientY - m.rect.top - m.origin.y) / (m.fit * zoom),
    };
  }

  function screenPoint(clientX, clientY) {
    const m = metrics();
    return { x: clientX - m.rect.left, y: clientY - m.rect.top };
  }

  function setTool(next) {
    tool = next;
    if (tool !== 'select') {
      selectedId = null;
      dragMode = null;
      draggingSelect = false;
    }
    Array.from(document.querySelectorAll('.tool')).forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-tool') === tool);
    });
    canvas.style.cursor = tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair';
    redraw();
  }

  function commitText() {
    if (!pendingText) return;
    const value = String(textInput.value || '').trim();
    if (value) {
      items.push({
        id: String(Date.now()),
        type: 'text',
        color,
        size: Math.max(14, brush * 4),
        point: pendingText.point,
        text: value,
      });
    }
    pendingText = null;
    textInput.style.display = 'none';
    textInput.value = '';
    redraw();
  }

  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    if (pendingText) {
      commitText();
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    const point = imagePoint(event.clientX, event.clientY);
    if (tool === 'pen') {
      drawing = true;
      draft = { id: String(Date.now()), type: 'pen', color, width: brush, points: [point] };
      return;
    }
    if (tool === 'arrow' || tool === 'box') {
      drawing = true;
      draft = { id: String(Date.now()), type: tool, color, width: brush, start: point, end: point };
      return;
    }
    if (tool === 'text') {
      const m = metrics();
      pendingText = { point };
      textInput.style.display = 'block';
      textInput.style.left = Math.min(Math.max(8, event.clientX - m.rect.left), m.rect.width - 180) + 'px';
      textInput.style.top = Math.min(Math.max(8, event.clientY - m.rect.top), m.rect.height - 44) + 'px';
      textInput.value = '';
      setTimeout(() => textInput.focus(), 10);
      return;
    }
    if (tool === 'select') {
      const sp = screenPoint(event.clientX, event.clientY);
      const current = items.find((it) => it.id === selectedId);
      if (current && current.type === 'arrow') {
        const m = metrics();
        const startPt = project(current.start, m.origin, m.fit, zoom);
        const endPt = project(current.end, m.origin, m.fit, zoom);
        if (Math.hypot(sp.x - startPt.x, sp.y - startPt.y) <= HANDLE_RADIUS) {
          dragMode = 'start';
          dragOrigin = { start: { ...current.start }, end: { ...current.end } };
          dragStartClient = { x: event.clientX, y: event.clientY };
          draggingSelect = true;
          return;
        }
        if (Math.hypot(sp.x - endPt.x, sp.y - endPt.y) <= HANDLE_RADIUS) {
          dragMode = 'end';
          dragOrigin = { start: { ...current.start }, end: { ...current.end } };
          dragStartClient = { x: event.clientX, y: event.clientY };
          draggingSelect = true;
          return;
        }
      }
      const hit = hitTest(sp);
      if (hit) {
        selectedId = hit.id;
        dragMode = 'move';
        dragOrigin =
          hit.type === 'text' ? { point: { ...hit.point } } : { start: { ...hit.start }, end: { ...hit.end } };
        dragStartClient = { x: event.clientX, y: event.clientY };
        draggingSelect = true;
      } else {
        selectedId = null;
        dragMode = null;
        draggingSelect = false;
      }
      redraw();
      return;
    }
    panning = true;
    panStart = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
  });

  canvas.addEventListener('pointermove', (event) => {
    if (drawing && draft) {
      const point = imagePoint(event.clientX, event.clientY);
      if (draft.type === 'pen') draft.points.push(point);
      else draft.end = point;
      redraw();
      return;
    }
    if (draggingSelect && selectedId && dragMode) {
      const item = items.find((it) => it.id === selectedId);
      if (item) {
        const m = metrics();
        const scale = m.fit * zoom;
        const dx = (event.clientX - dragStartClient.x) / scale;
        const dy = (event.clientY - dragStartClient.y) / scale;
        if (item.type === 'text') {
          item.point = { x: dragOrigin.point.x + dx, y: dragOrigin.point.y + dy };
        } else if (dragMode === 'start') {
          item.start = { x: dragOrigin.start.x + dx, y: dragOrigin.start.y + dy };
        } else if (dragMode === 'end') {
          item.end = { x: dragOrigin.end.x + dx, y: dragOrigin.end.y + dy };
        } else {
          item.start = { x: dragOrigin.start.x + dx, y: dragOrigin.start.y + dy };
          item.end = { x: dragOrigin.end.x + dx, y: dragOrigin.end.y + dy };
        }
      }
      redraw();
      return;
    }
    if (panning && tool === 'pan') {
      offset = {
        x: panStart.ox + (event.clientX - panStart.x),
        y: panStart.oy + (event.clientY - panStart.y),
      };
      redraw();
    }
  });

  function endPointer(event) {
    try { canvas.releasePointerCapture(event.pointerId); } catch (e) {}
    if (drawing && draft) {
      if (draft.type === 'pen' && draft.points.length >= 2) items.push(draft);
      else if ((draft.type === 'arrow' || draft.type === 'box') && Math.hypot(draft.end.x - draft.start.x, draft.end.y - draft.start.y) > 4) {
        items.push(draft);
      }
      draft = null;
      redraw();
    }
    drawing = false;
    panning = false;
    draggingSelect = false;
    dragMode = null;
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoom = Math.min(5, Math.max(0.4, +(zoom + (event.deltaY > 0 ? -0.12 : 0.12)).toFixed(2)));
    redraw();
  }, { passive: false });

  document.getElementById('zoomIn').onclick = () => { zoom = Math.min(5, +(zoom + 0.25).toFixed(2)); redraw(); };
  document.getElementById('zoomOut').onclick = () => { zoom = Math.max(0.4, +(zoom - 0.25).toFixed(2)); redraw(); };
  document.getElementById('resetZoom').onclick = () => { zoom = 1; offset = { x: 0, y: 0 }; redraw(); };
  document.getElementById('undo').onclick = () => {
    items = items.slice(0, -1);
    if (!items.find((it) => it.id === selectedId)) selectedId = null;
    redraw();
  };
  document.getElementById('clear').onclick = () => { items = []; selectedId = null; redraw(); };
  document.getElementById('save').onclick = () => {
    redraw();
    post({ type: 'save', dataUrl: canvas.toDataURL('image/png'), fileName: FILE_NAME });
  };
  brushEl.oninput = () => { brush = Number(brushEl.value) || 4; };
  Array.from(document.querySelectorAll('.tool')).forEach((el) => {
    el.addEventListener('click', () => setTool(el.getAttribute('data-tool')));
  });
  textInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); commitText(); }
    if (event.key === 'Escape') {
      pendingText = null;
      textInput.style.display = 'none';
      textInput.value = '';
    }
  });
  textInput.addEventListener('blur', () => { if (pendingText) commitText(); });

  image.onload = redraw;
  window.addEventListener('resize', redraw);
  setTool('pan');
})();
</script>
</body>
</html>`
}

export function ImageMarkupWebView({ src, fileName, active, entityType, entityId, onSavedCopy }: Props) {
  const webRef = useRef<WebView>(null)
  const html = useMemo(() => buildMarkupHtml(src, fileName), [src, fileName])

  if (!active) return <View style={styles.fill} />

  const handleSave = async (dataUrl: string, savedFileName: string) => {
    if (entityType && entityId) {
      try {
        await saveMarkupAsAttachmentCopy({
          dataUrl,
          fileName: savedFileName,
          entityType,
          entityId,
        })
        Alert.alert('Saved', 'Saved as new attachment')
        onSavedCopy?.()
      } catch (error: any) {
        Alert.alert(
          'Save failed',
          error?.message || 'Unable to save the marked-up image as a new attachment.'
        )
      }
      return
    }
    void shareDataUrl({ dataUrl, fileName: savedFileName })
  }

  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data)
      if (payload?.type === 'save' && payload.dataUrl) {
        void handleSave(payload.dataUrl, payload.fileName || fileName)
      }
    } catch {
      // ignore malformed messages
    }
  }

  return (
    <View style={styles.fill}>
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{ html, baseUrl: 'https://app.trimprony.com' }}
        onMessage={onMessage}
        style={styles.fill}
        allowsInlineMediaPlayback
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="always"
        setSupportMultipleWindows={false}
        androidLayerType="hardware"
      />
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0, backgroundColor: '#000' },
})
