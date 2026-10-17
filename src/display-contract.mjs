// Astra account display contract v1. Keep compatible with Workflow's astra_display_preferences.
export const displayPreferenceKey = 'astra_display_preferences';
export const displayFonts = {
  system: { label: 'Astra Via default', family: 'Inter, "Avenir Next", "Segoe UI", sans-serif' },
  arial: { label: 'Arial', family: 'Arial, Helvetica, sans-serif' },
  verdana: { label: 'Verdana', family: 'Verdana, Geneva, sans-serif' },
  georgia: { label: 'Georgia', family: 'Georgia, "Times New Roman", serif' },
};
export const defaultDisplayPreferences = Object.freeze({ version: 1, font: 'system', textSize: 16, textWeight: 'medium', spacing: 'comfortable', contrast: 'high', motion: 'system' });
export function validDisplayPreferences(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 7 && value.version === 1 &&
    Object.hasOwn(displayFonts, value.font) && [14, 16, 18, 20, 22].includes(value.textSize) && ['regular', 'medium', 'bold'].includes(value.textWeight) &&
    ['comfortable', 'roomy'].includes(value.spacing) && ['standard', 'high'].includes(value.contrast) && ['system', 'reduced'].includes(value.motion);
}
export function displayPreferences(value) {
  return validDisplayPreferences(value) ? Object.fromEntries(Object.keys(defaultDisplayPreferences).map(key => [key, value[key]])) : { ...defaultDisplayPreferences };
}
