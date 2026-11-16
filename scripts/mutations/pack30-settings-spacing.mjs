export const pack30SettingsSpacingMutations = [
  ["p30-spacing-margin", "public/styles/03-popovers-settings.css", "margin:12px 14px 0;line-height:1.45", "margin:8px 14px 0;line-height:1.45"],
  ["p30-spacing-inset", "public/styles/03-popovers-settings.css", "margin:12px 14px 0;line-height:1.45", "margin:12px 0 0;line-height:1.45"],
];
export const pack30SettingsSpacingCatchMap = Object.fromEntries(pack30SettingsSpacingMutations.map(([id]) => [id, "test/browser-settings-spacing.test.ts"]));
