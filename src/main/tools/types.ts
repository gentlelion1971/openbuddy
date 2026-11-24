// Shared contracts for the agent tool system.
// All code, comments, log messages and docs in this project are English only.

/** Per-project tool permissions. Enforced by the tool runner before any tool runs. */
export interface ProjectPermissions {
  /** Absolute folders the agent may read from and write to. For a project,
   *  empty means no folder access. For the main chat (projectId null),
   *  empty means unrestricted. */
  allowedFolders: string[];
  /** Whether the agent may send email at all in this project. */
  canSendEmail: boolean;
  /** Email account ids the agent may use. ['*'] means all connected accounts. */
  allowedEmailAccounts: string[];
  /** Whether the agent may fetch public web pages (read-only lookups). */
  canBrowseWeb: boolean;
  /** Whether the agent may drive a browser (fill and submit forms). */
  canRunBrowser: boolean;
  /** Whether the agent may write files. */
  canWriteFiles: boolean;
  /** Whether the agent may run local shell commands (reserved; default false). */
  canRunCommands: boolean;
}

/** Permissions for the main chat (no project). Full local access; sending email
 *  and other outward actions still require an explicit user confirmation. */
export const MAIN_CHAT_PERMISSIONS: ProjectPermissions = {
  allowedFolders: [],
  canSendEmail: true,
  allowedEmailAccounts: ['*'],
  canBrowseWeb: true,
  canRunBrowser: true,
  canWriteFiles: true,
  canRunCommands: false,
};

/** Permissions for a newly created project. Restrictive by default; the user
 *  opens them up per project in Settings. */
export const DEFAULT_PROJECT_PERMISSIONS: ProjectPermissions = {
  allowedFolders: [],
  canSendEmail: false,
  allowedEmailAccounts: [],
  canBrowseWeb: true,
  canRunBrowser: false,
  canWriteFiles: false,
  canRunCommands: false,
};

export interface ToolContext {
  /** Active project id, or null for the main chat. */
  projectId: string | null;
  /** Permissions resolved for the active project (or main chat). */
  permissions: ProjectPermissions;
}

export interface ToolResult {
  ok: boolean;
  /** Human-readable summary plus structured data for the model. Keep it small. */
  data?: unknown;
  error?: string;
}

export interface ToolDefinition {
  /** Unique tool name, e.g. "email_search". */
  name: string;
  /** Short description shown to the model and in Settings. */
  description: string;
  /** JSON Schema for the tool arguments (OpenAI function format). */
  parameters: Record<string, unknown>;
  /** True when the tool has an outward or destructive effect (send email,
   *  submit a form, pay, delete). The runner asks the user to confirm first. */
  requiresConfirmation: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

/** A confirmation request the main process sends to the renderer. */
export interface ConfirmationRequest {
  id: string;
  toolName: string;
  /** One-line summary, e.g. "Send email to cleon@wilmingtoncc.com". */
  summary: string;
  /** Full details shown in the confirmation dialog. */
  details: unknown;
}
