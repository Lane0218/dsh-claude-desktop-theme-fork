import type { Context } from '@deepseek-ai/cordis';
import type { ReactElement } from 'react';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { CleanupScope } from '../../core/cleanup.ts';
import type { Disposer } from '../../contracts/ports.ts';
import type { FeatureEnvironment } from '../../contracts/feature.ts';
import { DSH_SLOTS } from '../../compat/slots.ts';
import { QuoteAction } from './QuoteAction.tsx';
import css from './quote.css';

/**
 * This plugin's cell in the Chat view's selection surface. The key is also the
 * interaction id: DSH dispatches a gesture to the registrations in order and
 * renders the cell of the first one that claims it, so the id has to be ours
 * rather than the one a shipped quote plugin would use.
 */
export const QUOTE_ACTION_ID = 'ccd-quote';

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

/** The slot service face used here: one injection and one keyed registration. */
interface SlotSeat {
  inject(name: string, register: () => Disposer): Disposer;
  register(options: Record<string, unknown>, component: (props: never) => ReactElement | null): Disposer;
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
 * Claim a settled-text selection and offer the quote action on it.
 *
 * The registry admits one surface per gesture, so this function is also the
 * admission decision: a right-click, a collapsed range, or a Session that takes
 * no further prompt leaves the native interface untouched.
 *
 * Both seats are optional at run time. A build without the interaction registry
 * or the slot declares nothing and the plugin simply never draws the control,
 * which is what a version older than the pinned SDK would do.
 *
 * @param ctx - client context carrying `uiConversation`, `sessions` and `slots`.
 * @param environment - logging for this activation.
 * @param scope - scope owning the interaction and the slot registration.
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
  /* The cell goes in before the admission: a claimed gesture whose cell never
     registered would swallow the selection and draw nothing, which is worse
     than leaving every other occupant of that surface free to claim it. */
  scope.add(environment.dom.mountStyles(css));
  try {
    scope.add(slots.inject(DSH_SLOTS.textInteraction, () => slots.register(
      { name: DSH_SLOTS.textInteraction, key: QUOTE_ACTION_ID },
      QuoteAction,
    )));
  } catch (error) {
    environment.logger.error('quote: the selection surface refused the cell; the action stays off', error);
    return;
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
}
