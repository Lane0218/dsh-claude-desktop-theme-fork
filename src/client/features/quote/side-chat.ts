import type { Context } from '@deepseek-ai/cordis';
import { PLUGIN_ID } from '../../../shared/identity.ts';
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
 * The composer facade for one Session (`SessionInputResolver.for`): only the
 * two calls this module makes.
 */
interface InputFacade {
  setDraft(text: string): void;
  submit(): void;
}

interface ConversationInputFace {
  for(actx: Context): InputFacade;
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
 * The mention is written as the canonical Markdown form rather than inserted as
 * a reference chip: a chip serializes through its reference source, and this
 * build registers no `session` source (sending one fails with "no serializer for
 * reference source"). The host parses the canonical form out of the message
 * text, and the transcript still renders it as a chip through the shipped
 * `session` user-text rule.
 *
 * The quote is ordinary Markdown so it survives send as a block quote.
 *
 * @param label - the main Session's title, as the mention shows it.
 * @param sessionId - the Session the mention points at.
 * @param quote - the selected passage.
 * @returns the draft text, ready for `setDraft`.
 */
export function sideChatDraft(label: string, sessionId: string, quote: string): string {
  /* The label sits inside Markdown link brackets, so a bracket or a line break in
     it would end the mention early. */
  const safe = label.replace(/[[\]\r\n]/gu, ' ').replace(/\s+/gu, ' ').trim() || '主会话';
  const mention = `@[${safe}](${sessionReferenceUri(sessionId)})`;
  const quoted = quote.split(/\r?\n/gu).map(line => `> ${line}`).join('\n');
  return `${mention}\n\n${quoted}\n\n`;
}

/** One live tab's reference, released when that tab closes or the plugin unloads. */
const held = new Map<string, HeldReference>();

/** Session ids whose sidebar row stays out of the column while the side chat lives. */
const hiddenRows = new Set<string>();
let rowSheet: HTMLStyleElement | null = null;

/**
 * Rewrite the one injected rule that keeps side-chat rows out of the sidebar.
 *
 * The column's rows carry `data-row-key="session:<id>"` from the moment React
 * creates them (the same hook the blank-row rule uses), so a rule keyed by that
 * attribute hides a row even when it is not blank — which a side chat stops being
 * as soon as its first message is sent.
 */
function syncRowSheet(): void {
  if (typeof document === 'undefined') return;
  if (hiddenRows.size === 0) {
    rowSheet?.remove();
    rowSheet = null;
    return;
  }
  if (rowSheet === null) {
    rowSheet = document.createElement('style');
    rowSheet.dataset.plugin = PLUGIN_ID;
    document.head.appendChild(rowSheet);
  }
  rowSheet.textContent = [...hiddenRows]
    .map(id => `[data-row-key="session:${id}"]{display:none!important}`)
    .join('\n');
}

/** Keep one side chat's row out of the sidebar. */
export function hideSidebarRow(sessionId: string): void {
  hiddenRows.add(sessionId);
  syncRowSheet();
}

/** Stop hiding it; the host's own archive filter takes over from here. */
export function showSidebarRow(sessionId: string): void {
  hiddenRows.delete(sessionId);
  syncRowSheet();
}

export function releaseSideChat(sessionId: string): void {
  showSidebarRow(sessionId);
  const entry = held.get(sessionId);
  if (entry === undefined) return;
  held.delete(sessionId);
  try { entry.reference.release(); } catch { /* Already released. */ }
}

/** Every Session id a side chat is holding, for the plugin's own teardown. */
export function releaseAllSideChats(): void {
  for (const id of [...held.keys()]) releaseSideChat(id);
}

/** The workspace controller calls this module needs. */
interface WorkspaceArchiveFace {
  archiveSession?(sessionId: string, options?: { readonly stopActivity?: boolean }): Promise<unknown>;
}

/**
 * Close a side chat: archive its Session, then release the reference.
 *
 * Archiving is what makes "closing the tab" actually remove the conversation:
 * the host stops listing an archived Session, and it is also what stops a
 * running turn instead of leaving it in the background. A failure is only
 * logged — the tab still closes, and the row rule keeps the Session out of sight
 * until the reader notices it under the archived filter.
 *
 * @param ctx - client context carrying the workspace controller.
 * @param environment - logging for this activation.
 * @param sessionId - the side chat's Session.
 */
export async function closeSideChat(
  ctx: Context,
  environment: FeatureEnvironment,
  sessionId: string,
): Promise<void> {
  try {
    const face = (ctx as unknown as { uiWorkspace?: WorkspaceArchiveFace }).uiWorkspace;
    const archive = face?.archiveSession;
    if (typeof archive !== 'function') {
      environment.logger.debug('side chat: this build exposes no workspace archive; the Session is left as it is');
    } else {
      await archive.call(face, sessionId, { stopActivity: true });
    }
  } catch (error) {
    environment.logger.debug(`side chat: the Session could not be archived (${String(error)})`);
  }
  releaseSideChat(sessionId);
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
 * @returns the new Session and the chip label, or undefined when nothing was made.
 */
export async function createSideChat(
  ctx: Context,
  environment: FeatureEnvironment,
  mainSessionId: string,
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
  /* Blank is only true until the first message: the row rule carries it from
     there to the moment the tab closes and the Session is archived. */
  hideSidebarRow(sessionId);
  /* The chip names the Session the question is about, not the one asking it. */
  const label = readTitle(mainSessionId) ?? '主会话';
  try {
    await alignModel(ctx, sessions, main, sessionId);
  } catch (error) {
    environment.logger.debug(`side chat: model alignment failed (${String(error)})`);
  }
  return { sessionId, label };
  /* The title is read after creation so the chip carries what the sidebar shows. */
  function readTitle(id: string): string | undefined {
    const title = sessions.list.getSnapshot().byId[id] as { readonly title?: string } | undefined;
    return typeof title?.title === 'string' && title.title !== '' ? title.title : undefined;
  }
}

/** How long the composer may take to appear before the prefill gives up. */
const COMPOSER_WAIT_MS = 4000;
/** How often the prefill retries while the composer is not mounted yet. */
const COMPOSER_RETRY_MS = 60;
/** How long the permission command may take to be confirmed before writing anyway. */
const PERMISSION_WAIT_MS = 1500;
/** How many times the drafted passage is written before giving up on it sticking. */
const DRAFT_ATTEMPTS = 3;
/** How long each write is given to survive before it is read back. */
const DRAFT_SETTLE_MS = 350;

/**
 * Wait for one Session's composer to accept a draft, then run one write on it.
 *
 * The composer's editor is created when its Conversation mounts, and the side
 * chat's tab is what mounts it — so the draft cannot be written at creation
 * time. Every write is retried until the editor exists; a rejected write means
 * "not mounted yet", not "impossible".
 *
 * @param ctx - client context carrying the conversation service.
 * @param reference - the side chat's retained reference.
 * @param write - the single write to attempt once the composer answers.
 * @returns whether the write landed.
 */
async function whenComposerReady(
  ctx: Context,
  reference: SideChatReference,
  write: (facade: InputFacade) => void,
): Promise<boolean> {
  const deadline = Date.now() + COMPOSER_WAIT_MS;
  for (;;) {
    try {
      const input = (ctx.conversation as unknown as { input: ConversationInputFace }).input;
      write(input.for(reference.binding.ctx));
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => { setTimeout(resolve, COMPOSER_RETRY_MS); });
    }
  }
}

/**
 * The Session's permission projection, read only for change detection.
 *
 * The snapshot object is replaced on every host-confirmed update, so identity is
 * a sufficient signal; the field names inside it are none of this module's
 * business.
 */
function permissionSnapshot(reference: SideChatReference): unknown {
  try {
    return reference.binding.session.projections.faceOf('permissions').getSnapshot();
  } catch {
    return undefined;
  }
}

/**
 * Wait for the permission command to be confirmed before anything else writes.
 *
 * Submitting a command is asynchronous, and a settled command clears the draft
 * (that is how the composer consumes its token). Writing the visible draft
 * before that settlement is what made the chip and the quote appear for a moment
 * and then vanish, so this waits for the host to confirm the new preset — or for
 * the deadline, in which case the draft is written anyway.
 *
 * @param reference - the side chat's retained reference.
 * @param before - the projection value captured before submitting.
 */
async function permissionSettled(reference: SideChatReference, before: unknown): Promise<void> {
  const deadline = Date.now() + PERMISSION_WAIT_MS;
  for (;;) {
    if (permissionSnapshot(reference) !== before) return;
    if (Date.now() >= deadline) return;
    await new Promise(resolve => { setTimeout(resolve, COMPOSER_RETRY_MS); });
  }
}

/**
 * Pin the side chat to the read-only preset and put the question's context in
 * its composer.
 *
 * Order matters three times over. Every write waits for the composer, because
 * the tab that mounts it opens before this runs. The permission command goes
 * first because submitting a command consumes the draft. And the drafted quote
 * is written only after the command is confirmed, because a settled command
 * clears the draft it consumed — which is exactly what made the content flash.
 *
 * @param ctx - client context carrying the conversation service.
 * @param environment - logging for this activation.
 * @param target - the Session created for this side chat.
 * @param mainSessionId - the Session the passage came from.
 * @param quote - the selected passage.
 * @returns null on success, or the stage that refused the write.
 */
export async function prepareSideChat(
  ctx: Context,
  environment: FeatureEnvironment,
  target: SideChatTarget,
  mainSessionId: string,
  quote: string,
): Promise<string | null> {
  const entry = held.get(target.sessionId);
  if (entry === undefined) return '会话已释放';
  const reference = entry.reference;
  const permitted = await whenComposerReady(ctx, reference, facade => {
    facade.setDraft('/permission read-only');
  });
  if (!permitted) {
    environment.logger.error('side chat: the composer never became writable for the permission preset');
    return '输入框未就绪';
  }
  const before = permissionSnapshot(reference);
  await whenComposerReady(ctx, reference, facade => { facade.submit(); });
  await permissionSettled(reference, before);
  const draft = sideChatDraft(target.label, mainSessionId, quote);
  /* The probe is the quoted passage itself: at this point the tab holds only the
     composer, so finding that text there means the draft survived whatever wrote
     after it. A miss is not proof of failure, so the loop only decides whether
     to write again — the last successful write is what is reported. */
  const probe = quote.trim().slice(0, 8);
  let drafted = false;
  for (let attempt = 0; attempt < DRAFT_ATTEMPTS && !drafted; attempt += 1) {
    const written = await whenComposerReady(ctx, reference, facade => { facade.setDraft(draft); });
    if (!written) {
      environment.logger.error('side chat: the composer never accepted the draft');
      return '草稿写入失败';
    }
    await new Promise(resolve => { setTimeout(resolve, DRAFT_SETTLE_MS); });
    drafted = probe === '' || draftVisible(target.sessionId, probe);
  }
  if (!drafted) environment.logger.debug('side chat: the draft could not be read back after writing it');
  return null;
}

/**
 * Whether the side chat's composer still shows the drafted passage.
 *
 * @param sessionId - the side chat's Session, i.e. the tab body's marker.
 * @param probe - a distinctive prefix of the quoted passage.
 * @returns whether the text is present in that tab.
 */
function draftVisible(sessionId: string, probe: string): boolean {
  try {
    const tab = document.querySelector(`[data-ccd-side-chat="${CSS.escape(sessionId)}"]`);
    return tab?.textContent?.includes(probe) === true;
  } catch {
    return false;
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
