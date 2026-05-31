import type { Editor } from "@tiptap/react";
import type { LucideIcon } from "lucide-react";
import type {
  CrmEmailBrandingInput,
  CrmEmailMergeField,
  CrmEmailSignatureInput,
} from "@connect/shared";

export type Attachment = {
  id: string;
  templateId: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  isOptional: boolean;
  createdAt: string;
};

export type Template = {
  id: string;
  name: string;
  subject: string;
  previewText?: string | null;
  bodyText: string;
  bodyHtml?: string | null;
  bodyJson?: unknown;
  category?: string | null;
  isFavorite?: boolean;
  isDraft?: boolean;
  usageCount?: number;
  lastUsedAt?: string | null;
  visibility: "SHARED" | "PRIVATE";
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  attachments?: Attachment[];
};

export type StarterTemplate = {
  key: string;
  name: string;
  category: string;
  subject: string;
  previewText: string;
  bodyText: string;
  bodyHtml?: string;
};

export type EditorState = {
  id?: string;
  name: string;
  subject: string;
  previewText: string;
  bodyText: string;
  bodyHtml: string;
  category: string;
  isFavorite: boolean;
  isDraft: boolean;
  visibility: "SHARED" | "PRIVATE";
};

export type TemplateFolderKey = "all" | "favorites" | "recent" | "drafts" | "archived";

export type TemplateFolder = {
  key: TemplateFolderKey;
  label: string;
  count: number;
};

export type BuilderBlock = {
  label: string;
  group: string;
  icon: LucideIcon;
  html: string;
};

export type SaveState = "idle" | "dirty" | "autosaving" | "saved";

export type BuilderEditor = Editor | null;

export type UtilityPanelProps = {
  editor: BuilderEditor;
  branding: CrmEmailBrandingInput;
  signature: CrmEmailSignatureInput;
  attachments: Attachment[];
  fieldQuery: string;
  fieldGroups: Record<string, CrmEmailMergeField[]>;
  aiPrompt: string;
  uploadProgress: number | null;
  onBrandingChange: (branding: CrmEmailBrandingInput) => void;
  onSignatureChange: (signature: CrmEmailSignatureInput) => void;
  onSaveBranding: () => void;
  onSaveSignature: () => void;
  onLogoUpload: (file: File) => void;
  onLogoRemove: () => void;
  onAttachmentUpload: (file: File) => void;
  onAttachmentRemove: (id: string) => void;
  onMergeQueryChange: (query: string) => void;
  onInsertField: (field: CrmEmailMergeField) => void;
  onCopyField: (field: CrmEmailMergeField) => void;
  onAiPromptChange: (prompt: string) => void;
  onRunAi: (action: string) => void;
};
