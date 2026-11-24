import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import { ENTRY_ID } from '../../../shared/identity.ts';
import type { FeatureEnvironment } from '../../contracts/feature.ts';
import type { CleanupScope } from '../../core/cleanup.ts';
import type { ArchivedFilterIndex, ArchivedViewPort, ViewOptionsSettingsPort } from '../../contracts/ports.ts';
import { DSH_SLOTS } from '../../compat/slots.ts';
import { createViewOptionsDriver } from '../../compat/view-options.ts';
import { ViewOptionsCard } from './ViewOptionsCard.tsx';
import css from './view-options.css';

/** List order inside the frame-wide overlay; the pet occupies the earlier seat. */
const VIEW_OPTIONS_ORDER = 30;

/**
 * Put the sidebar's view-options card in the frame-wide overlay.
 *
 * The card is this plugin's own surface, so it is registered like one: a React
 * entry in `shell.overlay`, holding the driver that watches the host's trigger
 * and drives the host's own menu (`compat/view-options.ts`). Its own values,
 * `view.showEmptyGroups` and `view.groupByStatus`, go through the settings
 * transport the same way the configuration page writes its fields — a write
 * re-mounts the plugin, which is why the card closes behind the switch.
 *
 * Nothing here fails the interface if the trigger is missing: the driver reports
 * a card it cannot read and hands the click back to DSH, whose own menu opens.
 *
 * @param ctx - client root context carrying the slot service.
 * @param environment - configuration, ports and logging for this activation.
 * @param cleanup - scope owning the styles, the driver and the registration.
 */
export function mountViewOptions(
  ctx: Context,
  environment: FeatureEnvironment,
  cleanup: CleanupScope,
): { settings: ViewOptionsSettingsPort; showAllSessions(): void; archived: ArchivedViewPort } {
  cleanup.add(environment.dom.mountStyles(css));
  const driver = createViewOptionsDriver(
    document,
    error => environment.logger.error('view options: the sidebar trigger could not be watched', error),
  );
  cleanup.add(driver.dispose);
  const form = environment.host.configForms.get(ENTRY_ID);
  const registration = ctx.inject(['slots'], scope => scope.slots.inject(
    DSH_SLOTS.shellOverlay,
    () => scope.slots.register({
      name: DSH_SLOTS.shellOverlay, id: 'ccd-view-options', order: VIEW_OPTIONS_ORDER,
      inject: () => ({
        port: driver.port,
        showEmptyGroups: environment.config.view.showEmptyGroups,
        groupByStatus: environment.config.view.groupByStatus,
        setGroupByStatus: (value: boolean) => {
          void form.mutate(
            [{ op: 'set', path: ['view', 'groupByStatus'], value }],
            form.getSnapshot().revision,
          ).then(accepted => {
            if (!accepted) environment.logger.error('view options: status grouping write was refused');
          }, error => environment.logger.error('view options: status grouping write failed', error));
        },
        setShowEmptyGroups: (value: boolean) => {
          void form.mutate(
            [{ op: 'set', path: ['view', 'showEmptyGroups'], value }],
            form.getSnapshot().revision,
          ).then(
            accepted => {
              if (!accepted) environment.logger.error('view options: the show-empty-groups write was refused');
            },
            error => environment.logger.error('view options: the show-empty-groups write failed', error),
          );
        },
      }),
    }, ViewOptionsCard),
  ));
  cleanup.add(() => { void registration.dispose(); });
  // A settings patch or a native view change while the theme was disabled can
  // enable status grouping without first selecting the native flat body.
  if (environment.config.view.groupByStatus) {
    let off = () => {};
    const ensureFlat = () => {
      const value = driver.settings.getSnapshot();
      if (!value) return;
      off();
      if (value.groups[0]?.selected !== 2) {
        void driver.port.choose(0, 2).catch(error =>
          environment.logger.error('view options: flat status body could not be selected', error));
      }
    };
    off = driver.settings.subscribe(ensureFlat);
    cleanup.add(() => off());
  }
  void driver.inspect().catch(error => environment.logger.error('view options: preferences could not be read', error));
  /* The archived filter is one of the three values the driver reads; the account
     menu's own row is the one control outside this card that writes it, and it
     lives outside this feature, so it is handed the same port the card uses. */
  const archived: ArchivedViewPort = {
    read() {
      const selected = driver.settings.getSnapshot()?.groups[2]?.selected ?? -1;
      return selected === 0 || selected === 1 || selected === 2
        ? selected as ArchivedFilterIndex
        : null;
    },
    choose(filter: ArchivedFilterIndex) {
      return driver.port.choose(2, filter);
    },
    subscribe: listener => driver.settings.subscribe(listener),
  };
  return {
    settings: driver.settings,
    showAllSessions() {
      /* Back to the host's default — archived rows hidden — which is what the
         empty state's "show all sessions" promises: `show` would leave archived
         rows inline and keep the list in a filter the reader never chose. */
      void (async () => {
        await driver.port.choose(2, 0);
      })().catch(error => environment.logger.error('sidebar: show-all-sessions failed', error));
    },
    archived,
  };
}
