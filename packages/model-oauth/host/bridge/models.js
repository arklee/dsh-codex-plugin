// Adapted from DeepSeek Harness ed77a65860 (MIT; see LICENSE.deepseek).
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function getSupportedThinkingLevels(model) {
    if (!model.reasoning)
        return ['off'];
    return THINKING_LEVELS.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null)
            return false;
        if (level === 'xhigh' || level === 'max')
            return mapped !== undefined;
        return true;
    });
}
/**
 * Resolve transcript update modes from the exact model's protocol capabilities.
 * @param model - Materialized pi-ai model, including catalog compatibility flags.
 * @returns Update modes consumed by prompt admission and tool-history projection.
 */
export function conversationUpdates(model) {
    const compat = model.compat;
    if (compat === undefined || !('supportsMidConvoSystemMessages' in compat)
        || !compat.supportsMidConvoSystemMessages)
        return {};
    const updates = { systemPromptUpdate: 'in-history' };
    if (model.api === 'anthropic-messages'
        && 'supportsMidConvoToolChanges' in compat && compat.supportsMidConvoToolChanges) {
        updates.toolUpdate = 'in-history';
    }
    else if (model.api === 'openai-completions'
        && 'supportsMidConvoToolAdditions' in compat && compat.supportsMidConvoToolAdditions) {
        updates.toolUpdate = 'addition-only';
    }
    else if ((model.api === 'openai-responses' || model.api === 'azure-openai-responses' || model.api === 'openai-codex-responses')
        && (('supportsAdditionalTools' in compat && compat.supportsAdditionalTools)
            || ('supportsToolSearch' in compat && compat.supportsToolSearch))) {
        updates.toolUpdate = 'addition-only';
    }
    return updates;
}
