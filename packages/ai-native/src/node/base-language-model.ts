import { CoreMessage, ToolExecutionOptions, jsonSchema, streamText, tool } from 'ai';

import { Autowired, Injectable } from '@opensumi/di';
import { ChatMessageRole, IAIBackServiceOption, IChatMessage } from '@opensumi/ide-core-common';
import { ChatReadableStream } from '@opensumi/ide-core-node';
import { CancellationToken } from '@opensumi/ide-utils';

import {
  IToolInvocationRegistryManager,
  ToolInvocationRegistryManager,
  ToolRequest,
} from '../common/tool-invocation-registry';

@Injectable()
export abstract class BaseLanguageModel {
  @Autowired(ToolInvocationRegistryManager)
  protected readonly toolInvocationRegistryManager: IToolInvocationRegistryManager;

  protected abstract initializeProvider(options: IAIBackServiceOption): any;

  private convertChatMessageRole(role: ChatMessageRole) {
    switch (role) {
      case ChatMessageRole.System:
        return 'system';
      case ChatMessageRole.User:
        return 'user';
      case ChatMessageRole.Assistant:
        return 'assistant';
      case ChatMessageRole.Function:
        return 'tool';
      default:
        return 'user';
    }
  }

  async request(
    request: string,
    chatReadableStream: ChatReadableStream,
    options: IAIBackServiceOption,
    cancellationToken?: CancellationToken,
  ): Promise<any> {
    const provider = this.initializeProvider(options);
    const clientId = options.clientId;
    if (!clientId) {
      throw new Error('clientId is required');
    }
    const registry = this.toolInvocationRegistryManager.getRegistry(clientId);
    const allFunctions = options.noTool ? [] : registry.getAllFunctions();
    return this.handleStreamingRequest(
      provider,
      request,
      allFunctions,
      chatReadableStream,
      options.history || [],
      options.modelId,
      options.temperature,
      options.topP,
      options.topK,
      options.providerOptions,
      options.trimTexts,
      cancellationToken,
    );
  }

  private convertToolRequestToAITool(toolRequest: ToolRequest) {
    return tool({
      description: toolRequest.description || '',
      // TODO 这里应该是 z.object 而不是 JSON Schema
      parameters: jsonSchema(toolRequest.parameters),
      execute: async (args: any, options: ToolExecutionOptions) =>
        await toolRequest.handler(JSON.stringify(args), options),
    });
  }

  protected abstract getModelIdentifier(provider: any, modelId?: string): any;

  protected async handleStreamingRequest(
    provider: any,
    request: string,
    tools: ToolRequest[],
    chatReadableStream: ChatReadableStream,
    history: IChatMessage[] = [],
    modelId?: string,
    temperature?: number,
    topP?: number,
    topK?: number,
    providerOptions?: Record<string, any>,
    trimTexts?: [string, string],
    cancellationToken?: CancellationToken,
  ): Promise<any> {
    try {
      const aiTools = Object.fromEntries(tools.map((tool) => [tool.name, this.convertToolRequestToAITool(tool)]));

      const abortController = new AbortController();
      if (cancellationToken) {
        cancellationToken.onCancellationRequested(() => {
          abortController.abort();
        });
      }

      const messages: CoreMessage[] = [
        ...history.map((msg) => ({
          role: this.convertChatMessageRole(msg.role) as any, // 这个 SDK 包里的类型不太好完全对应，
          content: msg.content,
        })),
        { role: 'user', content: request },
      ];
      const stream = streamText({
        model: this.getModelIdentifier(provider, modelId),
        maxTokens: 4096,
        tools: aiTools,
        messages,
        abortSignal: abortController.signal,
        experimental_toolCallStreaming: true,
        maxSteps: 12,
        temperature,
        topP: topP || 0.8,
        topK: topK || 1,
        providerOptions,
      });

      // 状态跟踪变量
      let isFirstChunk = true;
      let bufferedText = '';
      const pendingLines: string[] = [];
      for await (const chunk of stream.fullStream) {
        if (chunk.type === 'text-delta') {
          if (trimTexts?.length) {
            // 将收到的文本追加到缓冲区
            bufferedText += chunk.textDelta;

            // 处理第一个文本块的前缀（只处理一次）
            if (isFirstChunk && bufferedText.includes(trimTexts[0])) {
              bufferedText = bufferedText.substring(bufferedText.indexOf(trimTexts[0]) + trimTexts[0].length);
              isFirstChunk = false;
            }

            // 检查是否有完整的行，并将它们添加到待发送行队列
            const lines = bufferedText.split('\n');

            // 最后一个元素可能是不完整的行，保留在缓冲区
            bufferedText = lines.pop() || '';

            // 将完整的行添加到待发送队列
            if (lines.length > 0) {
              pendingLines.push(...lines);
            }

            // 发送除最后几行外的所有行（保留足够的行以处理后缀）
            while (pendingLines.length > 3) {
              // 保留最后3行以确保能完整识别后缀
              const lineToSend = pendingLines.shift() + '\n';
              chatReadableStream.emitData({ kind: 'content', content: lineToSend });
            }
          } else {
            chatReadableStream.emitData({ kind: 'content', content: chunk.textDelta });
          }
        } else if (chunk.type === 'tool-call') {
          chatReadableStream.emitData({
            kind: 'toolCall',
            content: {
              id: chunk.toolCallId || Date.now().toString(),
              type: 'function',
              function: { name: chunk.toolName, arguments: JSON.stringify(chunk.args) },
              state: 'complete',
            },
          });
        } else if (chunk.type === 'tool-call-streaming-start') {
          chatReadableStream.emitData({
            kind: 'toolCall',
            content: {
              id: chunk.toolCallId,
              type: 'function',
              function: { name: chunk.toolName },
              state: 'streaming-start',
            },
          });
        } else if (chunk.type === 'tool-call-delta') {
          chatReadableStream.emitData({
            kind: 'toolCall',
            content: {
              id: chunk.toolCallId,
              type: 'function',
              function: { name: chunk.toolName, arguments: chunk.argsTextDelta },
              state: 'streaming',
            },
          });
        } else if (chunk.type === 'tool-result') {
          chatReadableStream.emitData({
            kind: 'toolCall',
            content: {
              id: chunk.toolCallId,
              type: 'function',
              function: { name: chunk.toolName, arguments: JSON.stringify(chunk.args) },
              result: chunk.result,
              state: 'result',
            },
          });
        } else if (chunk.type === 'error') {
          chatReadableStream.emitError(new Error(chunk.error as string));
        }
      }

      if (trimTexts?.[1]) {
        // 完成处理所有块后，检查并发送剩余文本

        // 将剩余缓冲区加入待发送行
        if (bufferedText) {
          pendingLines.push(bufferedText);
        }

        // 处理最后一行可能存在的后缀
        if (pendingLines.length > 0) {
          let lastLine = pendingLines[pendingLines.length - 1];

          if (lastLine.endsWith(trimTexts[1])) {
            // 移除后缀
            lastLine = lastLine.substring(0, lastLine.length - trimTexts[1].length);
            pendingLines[pendingLines.length - 1] = lastLine;
          }
        }

        // 发送所有剩余的行
        for (let i = 0; i < pendingLines.length; i++) {
          const isLastLine = i === pendingLines.length - 1;
          const lineToSend = pendingLines[i] + (isLastLine ? '' : '\n');
          chatReadableStream.emitData({ kind: 'content', content: lineToSend });
        }
      }

      chatReadableStream.end();
    } catch (error) {
      // Use a logger service in production instead of console
      chatReadableStream.emitError(error);
    }

    return chatReadableStream;
  }
}
