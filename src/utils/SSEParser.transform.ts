export class SSEParserTransform extends TransformStream<string, any> {
    private buffer = '';
    private currentEvent: Record<string, any> = {};
    private dataLines: string[] = [];
    private logger?: { debug?: (msg: string, meta?: any) => void; info?: (msg: string, meta?: any) => void };

    constructor(logger?: { debug?: (msg: string, meta?: any) => void; info?: (msg: string, meta?: any) => void }) {
        super({
            transform: (chunk: string, controller) => {
                const decoder = new TextDecoder();
                // If the chunk is already a string, avoid double-decoding.
                const text = typeof chunk === "string" ? chunk : decoder.decode(chunk as any);
                this.buffer += text;
                const lines = this.buffer.split('\n');

                // 保留最后一行（可能不完整）
                this.buffer = lines.pop() || '';

                for (const line of lines) {
                    const event = this.processLine(line);
                    if (event) {
                        controller.enqueue(event);
                    }
                }
            },
            flush: (controller) => {
                // 处理缓冲区中剩余的内容
                if (this.buffer.trim()) {
                    const events: any[] = [];
                    this.processLine(this.buffer.trim(), events);
                    events.forEach(event => controller.enqueue(event));
                }

                // 推送最后一个事件（如果有）
                if (Object.keys(this.currentEvent).length > 0) {
                    controller.enqueue(this.flushCurrentEvent());
                }
            }
        });
        this.logger = logger;
    }

    private processLine(line: string, events?: any[]): any | null {
        if (!line.trim()) {
            if (Object.keys(this.currentEvent).length > 0) {
                const event = this.flushCurrentEvent();
                if (events) {
                    events.push(event);
                    return null;
                }
                return event;
            }
            return null;
        }

        if (line.startsWith('event:')) {
            this.currentEvent.event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            // Accumulate multi-line data blocks per SSE spec.
            this.dataLines.push(line.slice(5).trim());
        } else if (!this.dataLines.length && this.looksLikeJson(line)) {
            // Fallback: some providers may omit the "data:" prefix and stream raw JSON lines.
            this.dataLines.push(line.trim());
        } else if (line.startsWith('id:')) {
            this.currentEvent.id = line.slice(3).trim();
        } else if (line.startsWith('retry:')) {
            this.currentEvent.retry = parseInt(line.slice(6).trim());
        }
        return null;
    }

    private looksLikeJson(line: string): boolean {
        const t = line.trim();
        return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
    }

    private flushCurrentEvent() {
        // Join accumulated data lines
        if (this.dataLines.length) {
            const dataJoined = this.dataLines.join('\n');
            if (dataJoined === '[DONE]') {
                this.currentEvent.data = { type: 'done' };
            } else {
                try {
                    this.currentEvent.data = JSON.parse(dataJoined);
                    if (process.env.LOG_SSE_DEBUG === "1") {
                        try {
                            this.logger?.info?.(this.currentEvent.data, "[SSEParser] parsed data");
                            const rc =
                                (this.currentEvent.data as any)?.delta?.reasoning_content ??
                                (this.currentEvent.data as any)?.choices?.[0]?.delta?.reasoning_content ??
                                (this.currentEvent.data as any)?.choices?.[0]?.delta?.reasoning;
                            if (rc) {
                                this.logger?.info?.(
                                    { reasoning_content: rc, raw: dataJoined },
                                    "[SSEParser] reasoning_content seen"
                                );
                            }
                        } catch {
                            // ignore debug errors
                        }
                    }
                    // Preserve raw payload alongside parsed data for fidelity.
                    (this.currentEvent.data as any)._raw = dataJoined;
                } catch (e) {
                    this.currentEvent.data = { raw: dataJoined, error: 'JSON parse failed' };
                }
            }
            this.dataLines = [];
        }
        const event = { ...this.currentEvent };
        this.currentEvent = {};
        return event;
    }
}
