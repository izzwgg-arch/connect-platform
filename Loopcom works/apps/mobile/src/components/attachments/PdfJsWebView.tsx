import React, { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { WebView } from 'react-native-webview'
import * as FileSystem from 'expo-file-system/legacy'
import { downloadAttachmentToCache } from '../../services/open-attachment'
import { BRAND } from '../../config/env'

type Props = {
  url: string
  fileName?: string | null
  mimeType?: string | null
  onOpenExternal: () => void
  openingExternal?: boolean
}

function buildPdfHtml(base64: string): string {
  // PDF.js renders the file in-webview. Android System WebView does not display
  // PDFs from https:// or content:// on most devices (blank page).
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=3" />
  <style>
    html, body { margin: 0; padding: 0; background: #111; color: #ddd; font-family: sans-serif; }
    #status { padding: 16px; text-align: center; }
    #pages { padding: 8px; }
    canvas { display: block; width: 100%; height: auto; margin: 0 auto 12px; background: #fff; }
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
</head>
<body>
  <div id="status">Loading PDF…</div>
  <div id="pages"></div>
  <script>
    (function () {
      var statusEl = document.getElementById('status');
      var pagesEl = document.getElementById('pages');
      try {
        if (!window.pdfjsLib) throw new Error('PDF engine failed to load (need network once).');
        pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        var raw = atob(${JSON.stringify(base64)});
        var bytes = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        pdfjsLib.getDocument({ data: bytes }).promise.then(function (pdf) {
          statusEl.textContent = pdf.numPages + ' page' + (pdf.numPages === 1 ? '' : 's');
          var chain = Promise.resolve();
          for (var p = 1; p <= pdf.numPages; p++) {
            (function (pageNum) {
              chain = chain.then(function () {
                return pdf.getPage(pageNum).then(function (page) {
                  var scale = 1.4;
                  var viewport = page.getViewport({ scale: scale });
                  var canvas = document.createElement('canvas');
                  var ctx = canvas.getContext('2d');
                  canvas.width = viewport.width;
                  canvas.height = viewport.height;
                  pagesEl.appendChild(canvas);
                  return page.render({ canvasContext: ctx, viewport: viewport }).promise;
                });
              });
            })(p);
          }
          return chain;
        }).catch(function (err) {
          statusEl.textContent = 'Could not render PDF: ' + (err && err.message ? err.message : err);
        });
      } catch (err) {
        statusEl.textContent = 'Could not render PDF: ' + (err && err.message ? err.message : err);
      }
    })();
  </script>
</body>
</html>`
}

export function PdfJsWebView({
  url,
  fileName,
  mimeType,
  onOpenExternal,
  openingExternal,
}: Props) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setHtml(null)
    setError(null)
    setLoading(true)

    void (async () => {
      try {
        const downloaded = await downloadAttachmentToCache({
          url,
          fileName,
          mimeType: mimeType || 'application/pdf',
        })
        const base64 = await FileSystem.readAsStringAsync(downloaded.localUri, {
          encoding: FileSystem.EncodingType.Base64,
        })
        if (cancelled) return
        // Guard extremely large PDFs — fall back to external open.
        if (base64.length > 18_000_000) {
          setError('PDF is too large to preview in-app. Tap Open with…')
          return
        }
        setHtml(buildPdfHtml(base64))
      } catch (e: any) {
        if (cancelled) return
        setError(e?.message || 'Could not load PDF')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [url, fileName, mimeType])

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#fff" size="large" />
        <Text style={styles.meta}>Downloading PDF…</Text>
      </View>
    )
  }

  if (error || !html) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>{fileName || 'PDF'}</Text>
        <Text style={styles.meta}>{error || 'PDF preview unavailable.'}</Text>
        <Pressable style={styles.btn} onPress={onOpenExternal} disabled={openingExternal}>
          <Text style={styles.btnText}>{openingExternal ? 'Opening…' : 'Open with…'}</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <View style={styles.fill}>
      <WebView
        originWhitelist={['*']}
        source={{ html, baseUrl: 'https://cdnjs.cloudflare.com' }}
        style={styles.fill}
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess
        mixedContentMode="always"
        setSupportMultipleWindows={false}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.center}>
            <ActivityIndicator color="#fff" />
          </View>
        )}
      />
      <Pressable style={styles.fab} onPress={onOpenExternal} disabled={openingExternal}>
        <Text style={styles.btnText}>{openingExternal ? 'Opening…' : 'Open with…'}</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 24,
    backgroundColor: '#000',
  },
  title: { color: '#fff', fontSize: 16, fontWeight: '700', textAlign: 'center' },
  meta: { color: '#a1a1aa', fontSize: 12, textAlign: 'center' },
  btn: {
    marginTop: 8,
    backgroundColor: BRAND.primary,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  btnText: { color: '#fff', fontWeight: '700' },
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 24,
    backgroundColor: BRAND.primary,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
})
