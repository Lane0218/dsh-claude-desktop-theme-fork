/* The fork's own package name: the tarball, the bundle row, and the entry the
   client bundle registers under are all this string, so the identity checks in
   `scripts/check-package.mjs` and `tests/install-default.test.ts` keep holding
   after the rename away from upstream's name. */
export const PLUGIN_ID = 'dsh-claude-desktop-theme-fork';
/** Loader entry id declared by this package's bundle patch (cordis.patch.yml). */
export const ENTRY_ID = 'ui-skin-ccd-style';
export const TARGET_DSH_VERSION = '0.2.1-rc.3';
export const ROOT_ATTRIBUTE = 'data-dsh-ccd-style';
