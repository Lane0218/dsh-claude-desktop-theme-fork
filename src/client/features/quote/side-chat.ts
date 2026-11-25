import type { Context } from '@deepseek-ai/cordis';
import type { FeatureEnvironment } from '../../contracts/feature.ts';

/**
 * One Session row as this module reads it: the workspace it belongs to, and the
 * model selection its projection carries. Declared structurally — only these
 * members are used, and the real service objects are passed through unchanged.
 */
interface SessionRow {
  readonly cwd?: string;
  readonly blank?: boolean;
}

interface ModelSelection {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}

interface ModelSelectionProjection {
  readonly next?: ModelSelection;
}

interface SessionFace {
  readonly projections: { faceOf(key: string): { getSnapshot(): unknown } };
}

interface SessionBinding {
  readonly session: SessionFace;
  readonly ctx: Context;
}

interface SessionsFace {
  list: {
    getSnapshot(): { readonly byId: Record<string, SessionRow | undefined> };
  };
  binding(sessionId: string): SessionBinding | undefined;
  create(options: {
    readonly workspaceId?: string;
    readonly cwd?: string;
    readonly agentPreset?: string;
  }): Promise<string>;
  retain(sessionId: string, options: { readonly source: string }): SideChatReference;
  selectModel?(options: {
    readonly sessionId: string;
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
  }): Promise<{ readonly ok: boolean }>;
}

interface SideChatReference {
  readonly sessionId: string;
  readonly binding: SessionBinding;
  release(): void;
}

interface WorkspacesFace {
  list: { getSnapshot(): { readonly items: readonly { readonly workspaceId: string; readonly sessionIds: readonly string[] }[] } };
}

/**
 * The composer facade for one Session (`SessionInputResolver.for`). `setDraft`
 * is declared for strings, but the runtime resolves the same call through
 * `DraftSnapshot`, which is the only way to place a real reference chip.
 */
interface InputFacade {
  setDraft(draft: string | DraftSnapshot): void;
  submit(): void;
}

interface ConversationInputFace {
  for(actx: Context): InputFacade;
}

interface ReferenceEntry {
  readonly offset: number;
  readonly length: number;
  readonly clipboardText: string;
  readonly source: string;
  readonly ref: string;
  readonly label: string;
  readonly appearance?: 'session' | 'file' | 'folder';
}

interface DraftSnapshot {
  readonly text: string;
  readonly references: readonly ReferenceEntry[];
}

/** One reference the side chat keeps alive for as long as its tab is open. */
interface HeldReference {
  readonly reference: SideChatReference;
}

/** What a created side chat reports back to the caller. */
export interface SideChatTarget {
  readonly sessionId: string;
  readonly label: string;
}

/**
 * Encode one Session id as the canonical `dsh-session:` URI payload.
 * Mirrors `encodeSessionReferenceUri`: base64url of the JSON string.
 */
export function sessionReferenceUri(sessionId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify(sessionId));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  return `dsh-session:${base64}`;
}

/**
 * The prompt a fresh side chat starts from.
 *
 * The reference span is the chip; the quote is ordinary Markdown so it survives
 * send as a block quote. Offsets have to line up exactly — the host validates
 * that `text.slice(offset, offset + length)` equals `clipboardText`.
 *
 * @param label - the main Session's title, as the chip shows it.
 * @param sessionId - the Session the mention points at.
 * @param quote - the selected passage.
 * @returns the draft and the one reference it carries.
 */
export function sideChatDraft(label: string, sessionId: string, quote: string): DraftSnapshot {
  const mention = `@${label}`;
  const quoted = quote.split(/\r?\n/gu).map(line => `> ${line}`).join('\n');
  const text = `${mention}\n\n${quoted}\n\n`;
  return {
    text,
    references: [{
      offset: 0, length: mention.length, clipboardText: mention,
      source: 'session', ref: sessionReferenceUri(sessionId), label, appearance: 'session',
    }],
  };
}

/** One live tab's reference, released when that tab closes or the plugin unloads. */
const held = new Map<string, HeldReference>();

export function releaseSideChat(sessionId: string): void {
  const entry = held.get(sessionId);
  if (entry === undefined) return;
  held.delete(sessionId);
  try { entry.reference.release(); } catch { /* Already released. */ }
}

/** Every Session id a side chat is holding, for the plugin's own teardown. */
export function releaseAllSideChats(): void {
  for (const id of [...held.keys()]) releaseSideChat(id);
}

/**
 * The reference a side-chat tab renders with, retained on first sight.
 *
 * A tab record survives a reload while the hold does not, so the body asks here
 * rather than assuming the click that opened it is still on the stack.
 *
 * @param ctx - client context carrying the Session controller.
 * @param sessionId - Session the tab was opened for.
 * @returns the live reference, or nothing when the Session cannot be retained.
 */
export function referenceForSideChat(ctx: Context, sessionId: string): SideChatReference | undefined {
  const existing = held.get(sessionId);
  if (existing !== undefined) return existing.reference;
  try {
    const sessions = ctx.sessions as unknown as SessionsFace;
    const reference = sessions.retain(sessionId, { source: 'ccdSideChat' });
    held.set(sessionId, { reference });
    return reference;
  } catch {
    return undefined;
  }
}

/**
 * Create the Session a side chat runs in.
 *
 * It is a blank Session in the main Session's workspace: blank is what keeps it
 * out of the sidebar until the first message, and the workspace is what gives
 * it the same files. The model and the permission preset are then aligned with
 * the conversation the question came from, because a side chat that answers with
 * a different model — or that could edit files — is not the same conversation.
 *
 * @param ctx - client context carrying sessions, workspaces and the composer.
 * @param environment - logging for this activation.
 * @param mainSessionId - the Session the question was asked in.
 * @param quote - the selected passage.
 * @returns the new Session and the chip label, or undefined when nothing was made.
 */
export async function createSideChat(
  ctx: Context,
  environment: FeatureEnvironment,
  mainSessionId: string,
  quote: string,
): Promise<SideChatTarget | undefined> {
  const sessions = ctx.sessions as unknown as SessionsFace;
  const main = sessions.binding(mainSessionId);
  const row = sessions.list.getSnapshot().byId[mainSessionId];
  const workspaces = ctx.workspaces as unknown as WorkspacesFace | undefined;
  const workspaceId = workspaces?.list.getSnapshot().items
    .find(item => item.sessionIds.includes(mainSessionId))?.workspaceId;
  let sessionId: string;
  try {
    sessionId = await sessions.create({
      ...workspaceId === undefined ? {} : { workspaceId },
      ...row?.cwd === undefined ? {} : { cwd: row.cwd },
    });
  } catch (error) {
    environment.logger.error('side chat: the Session could not be created', error);
    return undefined;
  }
  const reference = sessions.retain(sessionId, { source: 'ccdSideChat' });
  held.set(sessionId, { reference });
  /* The chip names the Session the question is about, not the one asking it. */
  const label = readTitle(mainSessionId) ?? '主会话';
  try {
    await alignModel(ctx, sessions, main, sessionId);
  } catch (error) {
    environment.logger.debug(`side chat: model alignment failed (${String(error)})`);
  }
  try {
    applyReadOnly(ctx, reference);
  } catch (error) {
    environment.logger.debug(`side chat: the read-only preset was not applied (${String(error)})`);
  }
  try {
    const input = (ctx.conversation as unknown as { input: ConversationInputFace }).input;
    input.for(reference.binding.ctx).setDraft(sideChatDraft(label, mainSessionId, quote));
  } catch (error) {
    environment.logger.error('side chat: the draft could not be prefilled', error);
    releaseSideChat(sessionId);
    return undefined;
  }
  return { sessionId, label };
  /* The title is read after creation so the chip carries what the sidebar shows. */
  function readTitle(id: string): string | undefined {
    const title = sessions.list.getSnapshot().byId[id] as { readonly title?: string } | undefined;
    return typeof title?.title === 'string' && title.title !== '' ? title.title : undefined;
  }
}

/** Copy the main Session's model selection onto the side chat, when it has one. */
async function alignModel(
  ctx: Context,
  sessions: SessionsFace,
  main: SessionBinding | undefined,
  sessionId: string,
): Promise<void> {
  const projection = main?.session.projections.faceOf('modelSelection').getSnapshot() as
    | ModelSelectionProjection
    | undefined;
  const target = projection?.next;
  if (target?.provider === undefined || target.model === undefined) return;
  if (sessions.selectModel === undefined) return;
  await sessions.selectModel({
    sessionId, provider: target.provider, model: target.model,
    ...target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort },
  });
  void ctx;
}

/**
 * Pin the new Session to the read-only preset.
 *
 * Permission presets are only reachable through the composer's command
 * pipeline — there is no remote setter — so the command is typed into the side
 * chat's own composer and submitted before the reader ever sees it. It runs
 * before the prefill on purpose: submitting consumes the draft, so the visible
 * prompt has to land after it.
 */
function applyReadOnly(ctx: Context, reference: SideChatReference): void {
  const input = (ctx.conversation as unknown as { input: ConversationInputFace }).input;
  const facade = input.for(reference.binding.ctx);
  facade.setDraft('/permission read-only');
  facade.submit();
}
