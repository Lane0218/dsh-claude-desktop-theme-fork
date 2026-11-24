import type { FeatureId, StyleConfig } from '../../shared/config.ts';
import type { CleanupScope } from '../core/cleanup.ts';
import type { ArchivedViewPort, DomPort, HostServices, Logger } from './ports.ts';

export interface FeatureEnvironment {
  readonly config: StyleConfig;
  readonly host: HostServices;
  readonly dom: DomPort;
  readonly logger: Logger;
  /**
   * The sidebar's archived-filter driver, present while the sidebar feature is
   * on. It belongs to the activation rather than to one feature because the
   * driver is mounted by `apply.ts` (it needs the frame-wide overlay slot) and
   * read by the sidebar's account menu, which is a feature of its own.
   */
  readonly archivedView?: ArchivedViewPort;
}

interface FeatureMetadata {
  readonly id: FeatureId;
  readonly task: string;
}

export interface PlannedFeature extends FeatureMetadata {
  readonly status: 'planned';
}

export interface ImplementedFeature extends FeatureMetadata {
  readonly status: 'implemented';
  mount(environment: FeatureEnvironment, scope: CleanupScope): void;
}

export type FeatureDefinition = PlannedFeature | ImplementedFeature;
