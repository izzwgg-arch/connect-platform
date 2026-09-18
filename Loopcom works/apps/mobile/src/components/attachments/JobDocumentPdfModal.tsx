import React, { useState } from 'react'
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { PdfJsWebView } from './PdfJsWebView'
import { openAttachment } from '../../services/open-attachment'
import { BRAND } from '../../config/env'

export type JobDocumentPreview = {
  id: string
  title: string
  fileName: string
  url: string
}

type Props = {
  document: JobDocumentPreview | null
  onClose: () => void
}

export function JobDocumentPdfModal({ document, onClose }: Props) {
  const [opening, setOpening] = useState(false)
  const visible = Boolean(document)

  const onOpenExternal = async () => {
    if (!document) return
    setOpening(true)
    try {
      await openAttachment({
        url: document.url,
        fileName: document.fileName,
        mimeType: 'application/pdf',
      })
    } finally {
      setOpening(false)
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.header}>
          <View style={styles.headerTextWrap}>
            <Text style={styles.title} numberOfLines={1}>
              {document?.title || 'Document'}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {document?.fileName || 'PDF'}
            </Text>
          </View>
          <Pressable style={styles.headerBtn} onPress={onOpenExternal} disabled={!document || opening}>
            {opening ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Ionicons name="open-outline" size={16} color="#fff" />
                <Text style={styles.headerBtnText}>Open with…</Text>
              </>
            )}
          </Pressable>
          <Pressable style={styles.headerBtn} onPress={onClose}>
            <Text style={styles.headerBtnText}>Close</Text>
          </Pressable>
        </View>

        {document ? (
          <PdfJsWebView
            key={document.id}
            url={document.url}
            fileName={document.fileName}
            mimeType="application/pdf"
            onOpenExternal={onOpenExternal}
            openingExternal={opening}
          />
        ) : null}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#09090b' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  headerTextWrap: { flex: 1, minWidth: 0 },
  title: { color: '#fff', fontSize: 14, fontWeight: '700' },
  meta: { color: '#a1a1aa', fontSize: 12, marginTop: 2 },
  headerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minWidth: 64,
    justifyContent: 'center',
  },
  headerBtnText: { color: '#fff', fontWeight: '700', fontSize: 12 },
})
