export const managementStyles = `
.pbot-management {
  --pbot-bg: var(--dsw-alias-bg-base, #f8f9fb);
  --pbot-surface: var(--dsw-alias-bg-layer-1, #fff);
  --pbot-ink: var(--dsw-alias-label-primary, #20232b);
  --pbot-muted: var(--dsw-alias-label-secondary, #696e79);
  --pbot-line: var(--dsw-alias-border-l2, #e3e5eb);
  --pbot-accent: var(--dsw-alias-brand-primary, #4d6bfe);
  --pbot-tint: color-mix(in srgb, var(--pbot-accent) 9%, var(--pbot-surface));
  --pbot-danger: var(--dsw-alias-state-error-primary, #c93535);
  width: min(1180px, calc(100vw - 48px)); height: min(820px, calc(100dvh - 64px));
  max-width: none; max-height: none; padding: 0; margin: auto; overflow: hidden;
  border: 1px solid var(--pbot-line); border-radius: 12px; color: var(--pbot-ink); background: var(--pbot-surface);
  box-shadow: 0 12px 40px #0002; font: 14px/1.55 var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
}
.pbot-management::backdrop { background: #10182866; }
.pbot-management *, .pbot-management *::before, .pbot-management *::after { box-sizing: border-box; }
.pbot-management [hidden] { display: none !important; }
.pbot-management h2, .pbot-management h3, .pbot-management h4, .pbot-management p { margin: 0; }
.pbot-management h2 { font-size: 21px; font-weight: 600; }
.pbot-management h3 { font-size: 16px; font-weight: 600; }
.pbot-management h4 { font-size: 14px; font-weight: 600; }
.pbot-management button, .pbot-management input, .pbot-management select { font: inherit; color: inherit; }
.pbot-management button { appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px; padding: 7px 13px; border: 1px solid var(--pbot-line); border-radius: 8px; background: var(--pbot-surface); cursor: pointer; line-height: 1.4; }
.pbot-management button:hover:not(:disabled) { background: var(--pbot-tint); border-color: color-mix(in srgb, var(--pbot-accent) 40%, var(--pbot-line)); }
.pbot-management button:disabled { opacity: .45; cursor: not-allowed; }
.pbot-management :is(button, input, select, summary):focus-visible { outline: 2px solid var(--pbot-accent); outline-offset: 3px; }
.pbot-management button.pbot-primary { background: var(--pbot-accent); border-color: var(--pbot-accent); color: var(--pbot-surface); font-weight: 600; }
.pbot-management button.pbot-primary:hover:not(:disabled) { filter: brightness(.94); background: var(--pbot-accent); }
.pbot-management button.pbot-quiet { border-color: transparent; background: transparent; }
.pbot-management button[data-busy=true]::after { content: "…"; }
.pbot-shell { height: 100%; display: grid; grid-template-columns: 178px minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto; }
.pbot-header { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px; padding: 18px 22px; border-bottom: 1px solid var(--pbot-line); }
.pbot-brand { font-size: 16px; font-weight: 650; letter-spacing: -.3px; }
.pbot-location { color: var(--pbot-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; max-width: 65vw; }
.pbot-header-copy { min-width: 0; flex: 1; }
.pbot-management .pbot-close { width: 34px; padding: 0; font-size: 22px; }
.pbot-nav { display: flex; flex-direction: column; gap: 6px; padding: 22px 12px; background: var(--pbot-bg); border-right: 1px solid var(--pbot-line); }
.pbot-nav button { text-align: left; justify-content: space-between; border-color: transparent; background: transparent; padding: 11px 12px; color: var(--pbot-muted); }
.pbot-nav button[aria-selected=true] { color: var(--pbot-accent); background: var(--pbot-tint); font-weight: 600; }
.pbot-main { min-width: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: 26px 28px; }
.pbot-page-title { margin-bottom: 22px; display: grid; gap: 5px; }
.pbot-muted { color: var(--pbot-muted); font-size: 13px; overflow-wrap: anywhere; }
.pbot-footer { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px; padding: 10px 22px; border-top: 1px solid var(--pbot-line); color: var(--pbot-muted); font-size: 12px; }
.pbot-footer > span { flex: 1; }
.pbot-footer button { min-height: 28px; padding: 4px 9px; font-size: 12px; }
.pbot-notice { position: sticky; top: -26px; z-index: 2; padding: 12px 14px; margin: -6px 0 18px; border: 1px solid var(--pbot-line); border-left: 3px solid var(--pbot-accent); background: var(--pbot-surface); border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow-y: auto; }
.pbot-notice[data-tone=error] { border-left-color: var(--pbot-danger); }
.pbot-notice:empty { display: none; }
.pbot-stack { display: grid; gap: 16px; }
.pbot-between { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.pbot-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.pbot-counts { margin: -8px 0 20px !important; }
.pbot-setting { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 20px 0; border-top: 1px solid var(--pbot-line); }
.pbot-setting > div { min-width: 0; }
.pbot-setting h3 { margin-bottom: 8px; }
.pbot-setting > button { flex-shrink: 0; }
.pbot-card { padding: 18px; border: 1px solid var(--pbot-line); border-radius: 12px; background: var(--pbot-surface); min-width: 0; }
.pbot-card > :is(h3, .pbot-between) { margin-bottom: 12px; }
.pbot-badge { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; color: var(--pbot-muted); background: var(--pbot-bg); padding: 3px 8px; border-radius: 6px; font-size: 12px; font-weight: 500; white-space: nowrap; }
.pbot-badge::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.pbot-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px 18px; margin: 12px 0; font-size: 13px; }
.pbot-facts dt { color: var(--pbot-muted); }
.pbot-facts dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.pbot-disclosure { margin: 16px 0; padding: 12px 14px; border: 1px solid var(--pbot-line); border-radius: 10px; }
.pbot-disclosure > summary { cursor: pointer; font-size: 13px; font-weight: 550; }
.pbot-disclosure[open] > summary { margin-bottom: 16px; }
.pbot-disclosure .pbot-disclosure { background: var(--pbot-bg); }
.pbot-field { display: grid; gap: 6px; margin-bottom: 14px; min-width: 0; font-size: 13px; }
.pbot-field > span { font-weight: 500; }
.pbot-field :is(input,select) { width: 100%; min-width: 0; padding: 9px 10px; border: 1px solid var(--pbot-line); border-radius: 7px; background: var(--pbot-surface); line-height: 1.5; }
.pbot-field input::placeholder { color: var(--pbot-muted); opacity: .8; }
.pbot-empty { padding: 38px 20px; border: 1px dashed var(--pbot-line); border-radius: 12px; text-align: center; display: grid; gap: 8px; }
.pbot-empty h3 { font-weight: 550; }
.pbot-empty button { justify-self: center; margin-top: 10px; }
.pbot-prose { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 10px 0; line-height: 1.7; }
.pbot-raw { font: 12px/1.6 ui-monospace, SFMono-Regular, monospace; max-height: 340px; overflow: auto; }
.pbot-management .pbot-pagination { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 12px 0; color: var(--pbot-muted); font-size: 12px; }
.pbot-pagination button { font-size: 12px; min-height: 30px; padding: 5px 9px; }
.pbot-search { display: grid; grid-template-columns: minmax(0, 1fr) 130px auto; gap: 12px; align-items: end; }
.pbot-search .pbot-field { margin: 0; }
.pbot-search > button { margin-bottom: 2px; }
.pbot-history-results { display: grid; gap: 10px; margin: 18px 0; }
.pbot-history-results article { border: 1px solid var(--pbot-line); border-radius: 10px; padding: 16px; }
.pbot-history-results article[aria-current=true] { border-color: var(--pbot-accent); }
.pbot-warning { border-left: 3px solid var(--dsw-alias-state-warn-primary, #ab7a15); padding: 8px 12px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
@media (max-width: 800px) {
  .pbot-management { width: calc(100vw - 24px); height: calc(100dvh - 32px); border-radius: 12px; }
  .pbot-shell { grid-template-columns: 1fr; grid-template-rows: auto auto minmax(0, 1fr) auto; }
  .pbot-nav { flex-direction: row; padding: 8px 14px; border-right: 0; border-bottom: 1px solid var(--pbot-line); }
  .pbot-nav button { flex: 1; justify-content: center; padding: 8px; }
  .pbot-main { padding: 22px 18px; }
  .pbot-notice { top: -22px; }
  .pbot-header { padding: 14px 18px; }
}
@media (max-width: 600px) {
  .pbot-management { width: calc(100vw - 12px); height: calc(100dvh - 16px); }
  .pbot-grid { grid-template-columns: minmax(0, 1fr); }
  .pbot-search { grid-template-columns: minmax(0, 1fr) 110px; }
  .pbot-search > button { grid-column: 1 / -1; }
  .pbot-footer { padding: 8px 14px; }
  .pbot-location { max-width: 68vw; }
}
`;
