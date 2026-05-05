/**
 * Compatibility re-export.
 *
 * The real implementation lives in `@connect/shared/chatAttachmentStorage`
 * so both the API (uploads/downloads) and the worker (audio conversion +
 * re-upload for MMS) operate on the same driver. Existing API call sites
 * import from this local path; keep that surface stable by re-exporting.
 */
export {
  assertStorageKeyForThread,
  getChatAttachmentStorageDriver,
  getChatAttachmentStorageRoot,
  isAllowedChatMime,
  maxBytesForThread,
  readChatAttachment,
  readChatAttachmentBuffer,
  resolveChatStoragePath,
  sanitizePathSegment,
  statChatAttachment,
  writeChatAttachmentFile,
} from "@connect/shared/chatAttachmentStorage";
