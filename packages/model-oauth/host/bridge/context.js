// Adapted from DeepSeek Harness ed77a65860 (MIT; see LICENSE.deepseek).
/**
 * Harness request-history conversion into pi-ai's Context vocabulary.
 *
 * @module dsh-llm-pi-ai/context
 */
import { brandString } from '@deepseek-ai/dsh-brand';
import { extractTextContent, requestImageBudgetFailure, uniqueRequestImageRefs } from '@deepseek-ai/dsh-llm/message';
import { contentHasImage, LlmError, offloadedImageText, projectOffloadedImages, requestImageHandleText } from '@deepseek-ai/dsh-llm';
import { toPiAssistant } from "./replay.js";
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment';
import { DEFAULT_REQUEST_IMAGE_MAX_BYTES, DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET } from "./config.js";
function textBlocks(content) {
    return content.filter((block) => block.type === 'text' && block.text.length > 0);
}
/** Pre-join system text with blank lines because pi-ai joins separate blocks with single newlines. */
function systemText(content) {
    return extractTextContent(content, { separator: '\n\n', trim: true });
}
/** Recover the pi-ai toolResult message for one harness tool-role message. */
function toolResultOf(message, toolNames, content) {
    return {
        role: 'toolResult',
        toolCallId: message.toolCallId,
        toolName: toolNames.get(message.toolCallId) ?? 'unknown',
        content: content.length > 0 ? content : [{ type: 'text', text: '(no output)' }],
        isError: message.isError ?? false,
        timestamp: 0,
    };
}
/** Reject misplaced tool-change blocks and unsupported image roles before replay or image offloading. */
function assertSupportedHistory(messages) {
    for (const message of messages) {
        if (message.role !== 'developer' && message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal')) {
            throw new LlmError('Tool-change blocks require developer role', 'UNSUPPORTED_CONTENT');
        }
        if (message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content)) {
            throw new LlmError(`pi-ai cannot represent an image in an in-history ${message.role} message`, 'UNSUPPORTED_CONTENT');
        }
        if (message.role === 'system' && message.content.some(block => block.type !== 'text')) {
            throw new LlmError('pi-ai cannot represent non-text system messages', 'UNSUPPORTED_CONTENT');
        }
    }
}
function userContent(blocks, requestImages, resolveImageAccess) {
    const content = [];
    for (const block of blocks) {
        switch (block.type) {
            case 'text':
                if (block.text.length > 0)
                    content.push({ type: 'text', text: block.text });
                break;
            case 'image': {
                const version = requestImages.get(block.attachment.attachmentId);
                content.push({
                    type: 'text',
                    text: requestImageHandleText(block.attachment, version, resolveImageAccess(block.attachment)),
                });
                content.push({
                    type: 'image',
                    data: Buffer.from(version.data).toString('base64'),
                    mimeType: version.mediaType,
                });
                break;
            }
            default:
                // Other merge-extensible blocks are not user-input vocabulary for pi-ai.
                break;
        }
    }
    return content;
}
/** Convert a projected declaration without its harness-owned activation marker. */
function piTool(tool) {
    return { name: tool.name, description: tool.description, parameters: tool.parameters };
}
function toolsOf(options) {
    return options.tools?.filter(tool => !tool.deferLoading).map(piTool);
}
/** Combine request-level text and leading system history into the initial prompt. */
function splitSystemPrompt(options) {
    const text = [options.system];
    let end = 0;
    for (const message of options.messages) {
        if (message.role !== 'system')
            break;
        text.push(systemText(message.content));
        end++;
    }
    const systemPrompt = text.filter(Boolean).join('\n\n');
    return { systemPrompt: systemPrompt || undefined, messages: options.messages.slice(end) };
}
/** Assemble the request-level pi-ai context envelope shared by both conversion paths. */
function piContext(systemPrompt, options, messages) {
    const tools = toolsOf(options);
    return {
        ...systemPrompt !== undefined ? { systemPrompt } : {},
        messages,
        ...tools !== undefined && tools.length > 0 ? { tools } : {},
    };
}
/** Keep one developer event in one system update, resolving its projected tool declarations. */
function appendDeveloper(message, options, messages) {
    const content = systemText(message.content);
    const toolsAdded = [];
    const toolsRemoved = [];
    for (const block of message.content) {
        switch (block.type) {
            case 'text':
                break;
            case 'tool-addition': {
                const tool = options.tools?.find(tool => tool.name === block.toolName);
                if (tool === undefined)
                    throw new LlmError(`pi-ai tool update references undeclared tool "${block.toolName}"`, 'INVALID_REQUEST');
                toolsAdded.push(piTool(tool));
                break;
            }
            case 'tool-removal':
                toolsRemoved.push({ name: block.toolName });
                break;
            default:
                throw new LlmError(`pi-ai cannot represent developer content ${block.type}`, 'UNSUPPORTED_CONTENT');
        }
    }
    if (content.length === 0 && toolsAdded.length === 0 && toolsRemoved.length === 0)
        return;
    messages.push({
        role: 'system',
        content,
        timestamp: 0,
        ...toolsAdded.length === 0 ? {} : { toolsAdded },
        ...toolsRemoved.length === 0 ? {} : { toolsRemoved },
    });
}
function appendAssistant(message, messages, toolNames, onReplayDegrade, prefixDigests) {
    const assistant = toPiAssistant(message, onReplayDegrade, prefixDigests);
    for (const block of assistant.content) {
        if (block.type === 'toolCall')
            toolNames.set(brandString(block.id), block.name);
    }
    messages.push(assistant);
}
/** Append shared system, developer, and assistant roles; true when consumed. */
function appendSharedHistory(message, options, messages, toolNames, supportsMidConvoSystemMessages, onReplayDegrade, prefixDigests) {
    if (message.role === 'developer') {
        appendDeveloper(message, options, messages);
        return true;
    }
    if (message.role === 'system') {
        const content = systemText(message.content);
        if (content.length > 0) {
            if (supportsMidConvoSystemMessages) {
                messages.push({ role: 'system', content, timestamp: 0 });
            }
            else {
                const reminder = content.replaceAll('</system-reminder>', '<\\/system-reminder>');
                messages.push({ role: 'user', content: `<system-reminder>\n${reminder}\n</system-reminder>`, timestamp: 0 });
            }
        }
        return true;
    }
    if (message.role === 'assistant') {
        appendAssistant(message, messages, toolNames, onReplayDegrade, prefixDigests);
        return true;
    }
    return false;
}
function textOnlyContext(options, supportsMidConvoSystemMessages, onReplayDegrade, prefixDigests) {
    assertSupportedHistory(options.messages);
    const split = splitSystemPrompt(options);
    const toolNames = new Map();
    const messages = [];
    for (const message of split.messages) {
        if (contentHasImage(message.content)) {
            throw new LlmError('pi-ai image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT');
        }
        if (appendSharedHistory(message, options, messages, toolNames, supportsMidConvoSystemMessages, onReplayDegrade, prefixDigests))
            continue;
        if (message.role === 'tool') {
            messages.push(toolResultOf(message, toolNames, textBlocks(message.content)));
            continue;
        }
        messages.push({ role: 'user', content: textBlocks(message.content), timestamp: 0 });
    }
    return piContext(split.systemPrompt, options, messages);
}
/**
 * Resolve the request target for one source under the route budgets.
 * @param ref - normalized source image.
 * @param budget - resolved route pixel and byte limits.
 * @returns dimensions and byte target shared by serialization and screenshot coordinate mapping.
 */
export function requestImageTarget(ref, budget) {
    return {
        ...requestImageDimensions(ref.width, ref.height, budget.maxPixels, budget.maxWidth, budget.maxHeight),
        maxImageBytes: budget.maxImageBytes,
        imageTargetBytes: budget.maxImageBytes,
    };
}
export function toPiContext(options, images, onReplayDegrade, supportsMidConvoSystemMessages = false, prefixDigests) {
    return images === undefined
        ? textOnlyContext(options, supportsMidConvoSystemMessages, onReplayDegrade, prefixDigests)
        : toPiContextWithImages(options, images, supportsMidConvoSystemMessages, onReplayDegrade, prefixDigests);
}
async function toPiContextWithImages(options, images, supportsMidConvoSystemMessages, onReplayDegrade, prefixDigests) {
    const { attachments, resolveImageAccess, maxRequestImageBytes, maxRequestImages, imageOffloadCountQuantum } = images;
    const requestImagePolicy = images.requestImagePolicy ?? {
        maxPixels: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
        maxImageBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    };
    assertSupportedHistory(options.messages);
    const split = splitSystemPrompt(options);
    const refs = uniqueRequestImageRefs(split.messages);
    const requestImages = new Map(await Promise.all(refs.map(async (ref) => {
        const version = await attachments.readImageRequest(ref, requestImageTarget(ref, requestImagePolicy), options.signal);
        return [ref.attachmentId, version];
    })));
    const failure = requestImageBudgetFailure(split.messages, requestImages, {
        representation: 'base64',
        ...maxRequestImageBytes === undefined ? {} : { maxBytes: maxRequestImageBytes },
        ...maxRequestImages === undefined ? {} : { maxImages: maxRequestImages },
        ...imageOffloadCountQuantum === undefined ? {} : { countQuantum: imageOffloadCountQuantum },
    }, 'pi-ai request images exceed the route image budget');
    if (failure !== undefined)
        throw LlmError.fromFailure(failure);
    const exactMessages = projectOffloadedImages(split.messages, ref => offloadedImageText(ref, resolveImageAccess(ref)));
    const toolNames = new Map();
    const messages = [];
    for (const message of exactMessages) {
        if (appendSharedHistory(message, options, messages, toolNames, supportsMidConvoSystemMessages, onReplayDegrade, prefixDigests))
            continue;
        if (message.role === 'tool') {
            messages.push(toolResultOf(message, toolNames, userContent(message.content, requestImages, resolveImageAccess)));
            continue;
        }
        const content = userContent(message.content, requestImages, resolveImageAccess);
        messages.push({ role: 'user', content, timestamp: 0 });
    }
    return piContext(split.systemPrompt, options, messages);
}
