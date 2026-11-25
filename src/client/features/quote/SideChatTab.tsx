import type { ReactElement, ReactNode } from 'react';

/**
 * The tab body of one side chat.
 *
 * The panel has already decided this tab exists; all this component does is bind
 * the Session the tab was opened for and hand the surface to the Chat view's own
 * conversation content. Every piece of chrome inside — transcript, streaming,
 * tool rows, composer, approvals — is the host's, which is the whole point: a
 * side chat should look and behave exactly like the conversation it came from.
 */
export interface SideChatTabProps {
  /** Framework seat: this tab's own record, including the params it was opened with. */
  readonly useTabInfo?: () => { readonly tab: { readonly navigation: { readonly params?: Record<string, unknown> } } };
  /** Framework seat: binds a Session reference to the subtree. */
  readonly SessionProvider?: (props: { readonly session: unknown; readonly children?: ReactNode }) => ReactElement;
  /** Framework seat: renders one declared child slot of this tab. */
  readonly renderSlot?: (name: string, props?: Record<string, unknown>) => ReactNode;
  /** Ours: the reference this tab holds for its Session. */
  readonly referenceFor?: (sessionId: string) => unknown;
}

/**
 * Bind the side chat's Session and render its conversation slot.
 * @param props - framework seats plus the reference lookup.
 * @returns the conversation, or nothing while the tab has no Session.
 */
export function SideChatTab(props: SideChatTabProps): ReactElement | null {
  const { useTabInfo, SessionProvider, renderSlot, referenceFor } = props;
  /* The seat is constant for a mount, so calling it conditionally keeps the hook
     order stable while still tolerating a build that does not inject it. */
  const info = useTabInfo === undefined ? undefined : useTabInfo();
  const raw = info?.tab.navigation.params?.['sessionId'];
  const sessionId = typeof raw === 'string' ? raw : undefined;
  const reference = sessionId === undefined ? undefined : referenceFor?.(sessionId);
  if (sessionId === undefined || reference === undefined
    || SessionProvider === undefined || renderSlot === undefined) return null;
  return (
    <div className="ccd-side-chat" data-ccd-side-chat={sessionId}>
      <SessionProvider session={reference}>
        {renderSlot('sidebar.chat.conversation', {}) as ReactElement}
      </SessionProvider>
    </div>
  );
}

/** What the conversation-content factory hands its occupants. */
interface ConversationProps {
  readonly renderFactorySlot?: (
    name: string,
    props: Record<string, unknown>,
    seats: { readonly slots: Record<string, unknown> },
  ) => ReactNode;
  readonly renderSlot?: (name: string, props?: Record<string, unknown>) => ReactNode;
}

/** The side chat is always the Chat view, never the trajectory ring. */
function ChatOnlyView(props: { readonly renderSlot?: (name: string, props?: Record<string, unknown>) => ReactNode }): ReactElement {
  return <>{props.renderSlot?.('conversation.session', { view: 'chat' })}</>;
}

/**
 * Render the shared conversation inside the side-chat tab.
 *
 * `embedded` is what removes the hero: the factory forces `hero: false` for that
 * variant, so a blank Session draws an empty transcript and its composer rather
 * than the new-session card. `active` keeps the shell out of its settling state
 * while the Session opens.
 *
 * @param props - factory and slot seats injected by the framework.
 * @returns the embedded conversation.
 */
export function SideChatConversation(props: ConversationProps): ReactElement | null {
  const { renderFactorySlot, renderSlot } = props;
  if (renderFactorySlot === undefined) return null;
  return renderFactorySlot(
    'conversation.content',
    { variant: 'embedded', phase: 'active', hero: false },
    { slots: { views: ChatOnlyView } },
  ) as ReactElement;
  /* `renderSlot` is part of the same injected set; referencing it keeps the
     parameter list honest for builds that inject both. */
  void renderSlot;
}
