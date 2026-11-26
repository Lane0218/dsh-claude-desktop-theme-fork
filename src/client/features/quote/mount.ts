import type { Context } from '@deepseek-ai/cordis';
import type { ReactElement } from 'react';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { CleanupScope } from '../../core/cleanup.ts';
import type { Disposer, SidebarRightPort } from '../../contracts/ports.ts';
import type { FeatureEnvironment } from '../../contracts/feature.ts';
import { DSH_SLOTS } from '../../compat/slots.ts';
import { resolveSidebarRight, resolveSidebarTabs } from '../../compat/sidebar-view.ts';
import { QuoteAction } from './QuoteAction.tsx';
import { SideChatConversation, SideChatTab } from './SideChatTab.tsx';
import { createSideChat, referenceForSideChat, releaseAllSideChats, releaseSideChat } from './side-chat.ts';
import css from './quote.css';

/**
 * This plugin's cell in the Chat view's selection surface. The key is also the
 * interaction id: DSH dispatches a gesture to the registrations in order and
 * renders the cell of the first one that claims it, so the id has to be ours
 * rather than the one a shipped quote plugin would use.
 */
export const QUOTE_ACTION_ID = 'ccd-quote';

/** The side chat's page kind, and its tab type id — one name for both. */
export const SIDE_CHAT_KIND = 'ccd-side-chat';

/**
 * The key the shipped quote plugin registers its cell under.
 *
 * `dsh-message-quotes` is part of the default web-app roster, and the Chat view
 * admits one interaction per gesture: its handler runs first and claims the
 * selection, so the surface renders *its* key. A keyed slot lets a later
 * registration take that key over, which is how this plugin draws both actions
 * in the one cell the host will show. The cell keeps the same props
 * (`trigger`/`readText`/`dismiss`/`clearSelection`), and the shipped handler has
 * already done its own Session checks before opening.
 */
const SHIPPED_QUOTE_KEY = 'quote';

/**
 * One admitted gesture, as `uiConversation.interactions.dispatch` builds it.
 * Declared structurally: the interaction registry is newer than the pinned SDK
 * types this plugin compiles against.
 */
interface TextInteractionRequest {
  readonly sessionId: string;
  /** `selection` for a text selection, `contextmenu` for a right-click. */
  readonly trigger: string;
  readonly hasSelection: boolean;
  readText(): string | null;
  preventDefault(): void;
  /** Claim the gesture; the surface then renders this interaction's cell. */
  open(): void;
}

interface TextInteractionsPort {
  register(definition: {
    readonly id: string;
    onInteraction(request: TextInteractionRequest): void;
  }): Disposer;
}

/** The slot service face used here: injections and keyed registrations. */
interface SlotSeat {
  inject(name: string, register: () => Disposer): Disposer;
  register(options: Record<string, unknown>, component: (props: never) => ReactElement | null): Disposer;
}

/**
 * The right-Sidebar page registry. `SidebarRightTabsPort` from the plugin's own
 * ports only reads it; a page type additionally registers itself here.
 */
interface TabTypes {
  register(definition: {
    readonly id: string;
    readonly kind: string;
    readonly title: () => string;
    readonly keepMounted?: boolean;
  }): Disposer;
  registerCloseHandler?(kind: string, handler: (tab: unknown) => void): Disposer;
}

/** The Session fields that decide whether another prompt is accepted. */
interface SessionFace {
  readonly removed?: boolean;
  readonly subagent?: { readonly address?: { readonly mode?: string } } | null;
}

interface SessionsFace {
  binding(sessionId: string): { readonly session: { getSnapshot(): SessionFace } } | undefined;
}

/**
 * Whether DSH will take another prompt in this Session.
 *
 * A removed Session and a one-shot child both refuse in the host; an archived
 * one is rejected at its next step, which is too late for a control that has
 * already promised the text went in.
 */
function acceptsPrompt(ctx: Context, sessionId: string): boolean {
  try {
    const sessions = ctx.sessions as unknown as SessionsFace;
    const session = sessions.binding(sessionId)?.session.getSnapshot();
    if (session === undefined || session.removed === true) return false;
    const subagent = session.subagent;
    return subagent == null || subagent.address?.mode === 'continuable';
  } catch {
    return false;
  }
}

/**
 * Read the right-Sidebar face without depending on it.
 *
 * The service is not in this plugin's `inject` list, so the context accessor
 * cannot see it; `get()` reads the registry directly and is the second chance
 * when the injection has not fired yet.
 *
 * @param ctx - client root context.
 * @returns the panel face, or nothing when this build does not carry it.
 */
function currentSidebar(ctx: Context): SidebarRightPort | undefined {
  try {
    const get = (ctx as unknown as { get?: (name: string) => unknown }).get;
    if (typeof get !== 'function') return undefined;
    const service = get.call(ctx, 'sidebarRight') as SidebarRightPort | undefined;
    return typeof service?.openTab === 'function' ? service : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claim a settled-text selection and offer both actions on it.
 *
 * The right-Sidebar face is deliberately *not* in this plugin's `inject` list —
 * naming it there would make the whole theme wait on the panel. It is read
 * inside its own injection instead, which is the only place the root context
 * can see it: read straight off `ctx`, both services are undefined and the
 * side-chat action would never appear.
 *
 * @param ctx - client root context carrying the interaction and slot services.
 * @param environment - logging for this activation.
 * @param scope - scope owning the styles, the cell, the interaction and the panel seats.
 */
export function mountQuoteSelection(ctx: Context, environment: FeatureEnvironment, scope: CleanupScope): void {
  const interactions = (ctx.uiConversation as unknown as { interactions?: TextInteractionsPort } | undefined)
    ?.interactions;
  if (interactions === undefined || typeof interactions.register !== 'function') {
    environment.logger.debug('quote: this build exposes no text interactions; the action stays off');
    return;
  }
  const slots = ctx.slots as unknown as SlotSeat | undefined;
  if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    environment.logger.debug('quote: no slot service; the action stays off');
    return;
  }
  /* Whatever the panel reports once it is up; the click reads it then, never at
     mount time, because the face arrives on its own schedule. */
  const panel: { sidebar?: SidebarRightPort | undefined } = {};
  /* The cell goes in before the admission: a claimed gesture whose cell never
     registered would swallow the selection and draw nothing, which is worse
     than leaving every other occupant of that surface free to claim it. */
  scope.add(environment.dom.mountStyles(css));
  const ask = (sessionId: string, text: string): void => {
    const sidebar = panel.sidebar ?? currentSidebar(ctx);
    if (sidebar === undefined) {
      environment.logger.debug('quote: the right panel is not up yet; the side chat was not opened');
      return;
    }
    void askInSideChat(ctx, environment, sidebar, sessionId, text);
  };
  const cell = { name: DSH_SLOTS.textInteraction, inject: () => ({ ask }) };
  for (const key of [SHIPPED_QUOTE_KEY, QUOTE_ACTION_ID]) {
    try {
      /* `quote` first: it is the cell the shipped handler will dispatch to, and
         replacing it is what puts both actions on screen. */
      scope.add(slots.inject(DSH_SLOTS.textInteraction, () => slots.register(
        { ...cell, key },
        QuoteAction,
      )));
    } catch (error) {
      environment.logger.error(`quote: the selection surface refused the '${key}' cell`, error);
    }
  }
  scope.add(interactions.register({
    id: QUOTE_ACTION_ID,
    onInteraction(request) {
      if (request.trigger !== 'selection' || !request.hasSelection) return;
      const text = request.readText();
      if (text === null || text.trim() === '') return;
      if (!acceptsPrompt(ctx, request.sessionId)) return;
      request.open();
    },
  }));
  const fiber = ctx.inject(['sidebarRight', 'sidebarRightTabs'], child => {
    const sidebar = resolveSidebarRight(child);
    const tabs = resolveSidebarTabs(child) as unknown as TabTypes | undefined;
    if (sidebar === undefined || tabs === undefined || typeof tabs.register !== 'function') {
      environment.logger.debug('quote: the right Sidebar is incomplete; the side-chat action stays off');
      return () => {};
    }
    panel.sidebar = sidebar;
    const stop = mountSideChat(ctx, environment, slots, tabs);
    return () => {
      panel.sidebar = undefined;
      stop();
    };
  });
  scope.add(() => { void (fiber as unknown as { dispose(): unknown }).dispose(); });
}

/**
 * Open one side chat for a selection, replacing any earlier one.
 *
 * "One at a time" is not a policy the panel can express, so the previous tab of
 * this kind is closed first: two side chats would each hold a Session, and only
 * one of them can be the answer to what the reader just selected.
 */
async function askInSideChat(
  ctx: Context,
  environment: FeatureEnvironment,
  sidebar: SidebarRightPort,
  mainSessionId: string,
  quote: string,
): Promise<void> {
  const target = await createSideChat(ctx, environment, mainSessionId, quote);
  if (target === undefined) return;
  try {
    const previous = sidebar.openTabs.getSnapshot()
      .filter(tab => tab.sessionId === mainSessionId && tab.kind === SIDE_CHAT_KIND);
    for (const tab of previous) sidebar.close?.(tab.tabId);
    sidebar.openTab(SIDE_CHAT_KIND, { params: { sessionId: target.sessionId } });
  } catch (error) {
    environment.logger.error('side chat: the right panel refused the tab', error);
    releaseSideChat(target.sessionId);
  }
}

/**
 * Register the side-chat page type, its body, and the conversation it renders.
 *
 * @param ctx - client context carrying the Session controller.
 * @param environment - logging for this activation.
 * @param slots - slot service, already guarded by the caller.
 * @param tabTypes - the panel's type registry, available only inside its injection.
 * @returns the disposer releasing every registration made here.
 */
function mountSideChat(
  ctx: Context,
  environment: FeatureEnvironment,
  slots: SlotSeat,
  tabTypes: TabTypes,
): Disposer {
  const disposers: Disposer[] = [];
  const release = () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose(); } catch { /* Keep releasing. */ }
    }
  };
  try {
    disposers.push(tabTypes.register({
      id: SIDE_CHAT_KIND,
      kind: SIDE_CHAT_KIND,
      title: () => (document.documentElement.lang || '').toLowerCase().startsWith('zh') ? '侧问' : 'Side chat',
      keepMounted: true,
    }));
    disposers.push(slots.inject('sidebar.right.pane.tab', () => slots.register({
      name: 'sidebar.right.pane.tab',
      key: SIDE_CHAT_KIND,
      children: { 'sidebar.chat.conversation': { kind: 'single', scope: 'session' } },
      inject: () => ({ referenceFor: (sessionId: string) => referenceForSideChat(ctx, sessionId) }),
    }, SideChatTab)));
    disposers.push(slots.inject('sidebar.chat.conversation', () => slots.register({
      name: 'sidebar.chat.conversation',
    }, SideChatConversation)));
    const offClose = tabTypes.registerCloseHandler?.(SIDE_CHAT_KIND, tab => {
      const record = tab as { readonly contentId?: string; readonly params?: { readonly sessionId?: string } } | undefined;
      const sessionId = record?.params?.sessionId ?? record?.contentId;
      if (typeof sessionId === 'string') releaseSideChat(sessionId);
    });
    if (offClose !== undefined) disposers.push(offClose);
    disposers.push(releaseAllSideChats);
  } catch (error) {
    environment.logger.error('side chat: the conversation seats were refused', error);
    release();
    return () => {};
  }
  return release;
}
