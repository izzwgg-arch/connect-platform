/** Phase 19I — shared types for the scripts playbook workspace. */

export type ScriptSummary = {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Script = ScriptSummary & {
  body: string;
};
