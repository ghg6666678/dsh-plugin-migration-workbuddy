/**
 * Theme-aware base layer for the migration settings UI.
 *
 * DSH declares its design tokens on <body> and overrides them under the
 * body[data-ds-dark-theme] attribute. Our custom properties must live on <body>
 * too: on :root they could not see body-level tokens and would always fall back
 * to the light palette. Colours with no matching token (brand accent, notice
 * banners, modal scrim) get an explicit dark tier. Every semantic colour keeps
 * its original light value as a fallback, so hosts without tokens are unchanged.
 */
export const THEME_CSS = `body{--mwb-surface:var(--dsw-alias-bg-layer-1,#fff);--mwb-surface-2:var(--dsw-alias-bg-layer-2,#f7fafc);--mwb-text:var(--dsw-alias-label-primary,#17202a);--mwb-text-2:var(--dsw-alias-label-secondary,#52606d);--mwb-text-3:var(--dsw-alias-label-tertiary,#708090);--mwb-border:var(--dsw-alias-border-l2,#e3e8ef);--mwb-divider:var(--sys-color-divider,#f0f3f7);--mwb-subtle-bg:#eef4f5;--mwb-active-bg:#e6f6f5;--mwb-icon-bg:#e8f7f4;--mwb-safe-bg:#f0faf8;--mwb-safe-border:#c6eee4;--mwb-safe-text:#4e6b6b;--mwb-error-bg:#fff5f5;--mwb-error-text:#b42318;--mwb-warn-bg:#fef3c7;--mwb-warn-text:#92400e;--mwb-accent:#087f8c;--mwb-mask:rgba(16,42,67,.35);--mwb-shadow:rgba(16,42,67,.2)}body[data-ds-dark-theme]{--mwb-subtle-bg:#1d2b33;--mwb-active-bg:#123a38;--mwb-icon-bg:#143a39;--mwb-safe-bg:#112b27;--mwb-safe-border:#1e5147;--mwb-safe-text:#a5d6ca;--mwb-error-bg:#361d1d;--mwb-error-text:#ff9c90;--mwb-warn-bg:#372c14;--mwb-warn-text:#f3cd7c;--mwb-accent:#5ee0d0;--mwb-mask:rgba(0,0,0,.62);--mwb-shadow:rgba(0,0,0,.5)}:where(.mwb-migration,.mwb-picker,.mwb-auto) :where(button,input){color:inherit;font-family:inherit}:where(.mwb-migration,.mwb-picker,.mwb-auto) :where(input){background:var(--mwb-surface,#fff)}`
