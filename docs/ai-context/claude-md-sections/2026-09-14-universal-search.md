# Universal search — 2026-09-14

The topbar previously only stored input. It now searches the authoritative sidebar catalog and personal/tenant settings, plus permission-gated record providers. Full implementation and release evidence: `docs/ai-context/AGENT_HANDOFF_UNIVERSAL_SEARCH_2026-09-14.md`.

Never use built-in role defaults to widen an authoritative custom permission set. Page/section grants and hidden-nav settings apply to search; calls, voicemail and CRM retain their existing data-scope handlers. Private chat requires membership unless the existing tenant-chat capability is granted. Search is read-only and creates no permission grants or PBX changes.

Implementation tested locally; production release verification is recorded in the full handoff. New sidebar pages automatically join page search; new record providers must explicitly preserve that area's access rules. This is not a database-wide index of every field, attachment or record type.
