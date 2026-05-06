import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useStreamBuffer } from '../hooks/useStreamBuffer';
import { ArrowUp, Check, Clock3, Copy, Cpu } from 'lucide-react';
import { motion } from 'framer-motion';
import nativelyIcon from './icon.png';
import { ModelSelector } from './ui/ModelSelector';
import { useResolvedTheme } from '../hooks/useResolvedTheme';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

// ============================================
// Types 
// ============================================

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    isStreaming?: boolean;
    modelUsed?: string;
    durationMs?: number;
    source?: 'rag' | 'fallback';
}

interface MeetingContext {
    id?: string;  // Required for RAG queries
    title: string;
    summary?: string;
    keyPoints?: string[];
    actionItems?: string[];
    transcript?: Array<{ speaker: string; text: string; timestamp: number }>;
}

interface MeetingChatOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    meetingContext: MeetingContext;
    initialQuery?: string;
    onNewQuery: (query: string) => void;
}

type ChatState = 'idle' | 'opening' | 'waiting_for_llm' | 'streaming_response' | 'error' | 'closing';

const formatResponseDuration = (ms?: number): string => {
    if (ms == null) return '';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
};

const getModelDisplayName = (model: string): string => {
    const names: Record<string, string> = {
        'gemini-3.1-flash-lite-preview': 'Gemini 3.1 Flash',
        'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
        'llama-3.3-70b-versatile': 'Groq Llama 3.3',
        'gpt-5.4': 'GPT 5.4',
        'gpt-4o': 'GPT 4o',
        'gpt-4o-mini': 'GPT 4o Mini',
        'gpt-5.2': 'GPT 5.2 Codex',
        'gpt-5.1': 'GPT 5.1 Codex',
        'codex:gpt-5.4': 'GPT 5.4 Codex',
        'codex:gpt-5.4-mini': 'GPT 5.4 Mini Codex',
        'codex:gpt-5.3': 'GPT 5.3 Codex',
        'codex:gpt-5.2': 'GPT 5.2 Codex',
        'codex:gpt-5.1': 'GPT 5.1 Codex',
        'codex:gpt-5': 'GPT 5 Codex',
        'claude-sonnet-4-6': 'Sonnet 4.6',
        natively: 'Natively',
    };
    return names[model] || (model.startsWith('ollama-') ? model.replace('ollama-', '') : model);
};

// ============================================
// Typing Indicator Component
// ============================================

const TypingIndicator: React.FC = () => (
    <div className="flex items-center gap-1 py-4">
        <div className="flex items-center gap-1">
            {[0, 1, 2].map((i) => (
                <motion.div
                    key={i}
                    className="w-2 h-2 rounded-full bg-text-tertiary"
                    animate={{ opacity: [0.4, 1, 0.4] }}
                    transition={{
                        duration: 0.6,
                        repeat: Infinity,
                        delay: i * 0.15,
                        ease: "easeInOut"
                    }}
                />
            ))}
        </div>
    </div>
);

// ============================================
// Message Components
// ============================================

const UserMessage: React.FC<{ content: string }> = ({ content }) => (
    <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className="flex justify-end mb-6"
    >
        <div className="bg-accent-primary text-white px-5 py-3 rounded-2xl rounded-tr-md max-w-[70%] text-[15px] leading-relaxed">
            {content}
        </div>
    </motion.div>
);

const AssistantMessage: React.FC<{ content: string; isStreaming?: boolean; modelUsed?: string; durationMs?: number; source?: 'rag' | 'fallback' }> = ({ content, isStreaming, modelUsed, durationMs, source }) => {
    const [copied, setCopied] = useState(false);
    const isLight = useResolvedTheme() === 'light';

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col items-start mb-6"
        >
            <div className={`text-[15px] leading-relaxed max-w-[85%] ${isLight ? 'text-text-primary' : 'text-slate-100'}`}>
                <div className="markdown-content">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeKatex]}
                        components={{
                            p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0 whitespace-pre-wrap" {...props} />,
                            a: ({ node, ...props }: any) => <a className="text-blue-500 hover:underline" {...props} />,
                            pre: ({ children }: any) => <div className="not-prose mb-4">{children}</div>,
                            code: ({ node, inline, className, children, ...props }: any) => {
                                const match = /language-(\w+)/.exec(className || '');
                                const isInline = inline ?? false;
                                const lang = match ? match[1] : '';

                                return !isInline ? (
                                    <div className={`my-3 rounded-xl overflow-hidden border shadow-lg backdrop-blur-md ${isLight ? 'border-border-subtle bg-bg-input' : 'border-white/[0.10] bg-zinc-900/90'}`}>
                                        <div className={`${isLight ? 'bg-bg-secondary border-border-subtle' : 'bg-white/[0.05] border-white/[0.08]'} px-3 py-1.5 border-b`}>
                                            <span className="text-[10px] uppercase tracking-widest font-semibold text-white/40 font-mono">
                                                {lang || 'CODE'}
                                            </span>
                                        </div>
                                        <div className="bg-transparent">
                                            <SyntaxHighlighter
                                                language={lang || 'text'}
                                                style={vscDarkPlus}
                                                customStyle={{
                                                    margin: 0,
                                                    borderRadius: 0,
                                                    fontSize: '13px',
                                                    lineHeight: '1.6',
                                                    background: 'transparent',
                                                    padding: '16px',
                                                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
                                                }}
                                                wrapLongLines={true}
                                                showLineNumbers={true}
                                                lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1.2em', color: 'rgba(255,255,255,0.2)', textAlign: 'right', fontSize: '11px' }}
                                                {...props}
                                            >
                                                {String(children).replace(/\n$/, '')}
                                            </SyntaxHighlighter>
                                        </div>
                                    </div>
                                ) : (
                                    <code className="bg-bg-input px-1.5 py-0.5 rounded text-[13px] font-mono text-text-primary border border-border-subtle whitespace-pre-wrap" {...props}>
                                        {children}
                                    </code>
                                );
                            },
                        }}
                    >
                        {content}
                    </ReactMarkdown>
                </div>
                {isStreaming && (
                    <motion.span
                        className="inline-block w-0.5 h-4 bg-text-secondary ml-0.5 align-middle"
                        animate={{ opacity: [1, 0] }}
                        transition={{ duration: 0.5, repeat: Infinity }}
                    />
                )}
            </div>
            {!isStreaming && content && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-medium text-text-secondary">
                    {modelUsed && (
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-input px-2 py-1 text-text-primary">
                            <Cpu size={12} />
                            {modelUsed}
                        </span>
                    )}
                    {durationMs != null && (
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-input px-2 py-1 tabular-nums text-text-primary">
                            <Clock3 size={12} />
                            {formatResponseDuration(durationMs)}
                        </span>
                    )}
                    {source && (
                        <span className="rounded-md border border-border-subtle bg-bg-input px-2 py-1 text-text-secondary">
                            {source === 'rag' ? 'RAG' : 'Fallback'}
                        </span>
                    )}
                    <button
                        onClick={handleCopy}
                        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-text-tertiary hover:bg-bg-input hover:text-text-primary transition-colors"
                    >
                        {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
                        {copied ? 'Copied' : 'Copy'}
                    </button>
                </div>
            )}
        </motion.div>
    );
};

// ============================================
// Main Component
// ============================================

const MeetingChatOverlay: React.FC<MeetingChatOverlayProps> = ({
    isOpen,
    onClose,
    meetingContext,
    initialQuery = '',
    // onNewQuery
}) => {
    const isLight = useResolvedTheme() === 'light';
    const [messages, setMessages] = useState<Message[]>([]);
    const [chatState, setChatState] = useState<ChatState>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [currentModel, setCurrentModel] = useState('gemini-3.1-flash-lite-preview');

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const chatWindowRef = useRef<HTMLDivElement>(null);
    const streamBuffer = useStreamBuffer();
    const currentModelRef = useRef(currentModel);

    useEffect(() => {
        currentModelRef.current = currentModel;
    }, [currentModel]);

    useEffect(() => {
        window.electronAPI?.getDefaultModel?.()
            .then((result: { model?: string } | undefined) => {
                if (result?.model) setCurrentModel(result.model);
            })
            .catch((err: any) => console.error('[MeetingChat] Failed to load model:', err));

        const unsubscribe = window.electronAPI?.onModelChanged?.((modelId: string) => {
            setCurrentModel(modelId);
        });

        return () => unsubscribe?.();
    }, []);

    const handleModelSelect = (modelId: string) => {
        setCurrentModel(modelId);
        window.electronAPI?.setModel?.(modelId).catch((err: any) => console.error('[MeetingChat] Failed to set model:', err));
    };

    // Submit initial query when overlay opens
    useEffect(() => {
        if (isOpen && initialQuery && messages.length === 0) {
            setChatState('opening');
            setTimeout(() => {
                submitQuestion(initialQuery);
            }, 100);
        }
    }, [isOpen, initialQuery]);

    // Listen for new queries from parent
    useEffect(() => {
        if (isOpen && initialQuery && messages.length > 0) {
            // This is a follow-up query
            submitQuestion(initialQuery);
        }
    }, [initialQuery]);

    // ESC key handler
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                handleClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen]);

    const handleClose = useCallback(() => {
        onClose();
    }, [onClose]);

    // Build context string for LLM
    const buildContextString = useCallback((): string => {
        const parts: string[] = [];

        parts.push(`MEETING: ${meetingContext.title}`);

        if (meetingContext.summary) {
            parts.push(`\nSUMMARY:\n${meetingContext.summary}`);
        }

        if (meetingContext.keyPoints?.length) {
            parts.push(`\nKEY POINTS:\n${meetingContext.keyPoints.map(p => `- ${p}`).join('\n')}`);
        }

        if (meetingContext.actionItems?.length) {
            parts.push(`\nACTION ITEMS:\n${meetingContext.actionItems.map(a => `- ${a}`).join('\n')}`);
        }

        if (meetingContext.transcript?.length) {
            const recentTranscript = meetingContext.transcript.slice(-20);
            const transcriptText = recentTranscript
                .map(t => `[${t.speaker === 'user' ? 'Me' : 'Them'}]: ${t.text}`)
                .join('\n');
            parts.push(`\nRECENT TRANSCRIPT:\n${transcriptText}`);
        }

        return parts.join('\n');
    }, [meetingContext]);

    // Submit question using RAG streaming
    const submitQuestion = useCallback(async (question: string) => {
        if (!question.trim() || chatState === 'waiting_for_llm' || chatState === 'streaming_response') return;

        const userMessage: Message = {
            id: `user-${Date.now()}`,
            role: 'user',
            content: question
        };
        setMessages(prev => [...prev, userMessage]);
        setChatState('waiting_for_llm');
        setErrorMessage(null);

        // Scroll to bottom when user sends message
        setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 50);

        const assistantMessageId = `assistant-${Date.now()}`;
        const startedAt = Date.now();
        const modelAtStart = getModelDisplayName(currentModelRef.current);

        try {
            // Add typing indicator delay (200ms) - makes the AI feel "thoughtful"
            await new Promise(resolve => setTimeout(resolve, 200));

            // Create assistant message placeholder
            setMessages(prev => [...prev, {
                id: assistantMessageId,
                role: 'assistant',
                content: '',
                isStreaming: true
            }]);

            // Set up RAG streaming listeners (RAF-batched to avoid per-token re-renders)
            streamBuffer.reset();
            const tokenCleanup = window.electronAPI?.onRAGStreamChunk((data: { chunk: string }) => {
                setChatState('streaming_response');
                streamBuffer.appendToken(data.chunk, (content) => {
                    setMessages(prev => prev.map(msg =>
                        msg.id === assistantMessageId
                            ? { ...msg, content }
                            : msg
                    ));
                });
            });

            const doneCleanup = window.electronAPI?.onRAGStreamComplete(() => {
                // Final commit — flush any remaining buffered content
                const finalContent = streamBuffer.getBufferedContent();
                setMessages(prev => prev.map(msg =>
                    msg.id === assistantMessageId
                        ? { ...msg, content: finalContent, isStreaming: false, modelUsed: modelAtStart, durationMs: Date.now() - startedAt, source: 'rag' }
                        : msg
                ));
                setChatState('idle');
                streamBuffer.reset();
                tokenCleanup?.();
                doneCleanup?.();
                errorCleanup?.();
            });

            const errorCleanup = window.electronAPI?.onRAGStreamError((data: { error: string }) => {
                console.error('[MeetingChat] RAG stream error:', data.error);
                setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
                setErrorMessage("Couldn't get a response. Please try again.");
                setChatState('error');
                streamBuffer.reset();
                tokenCleanup?.();
                doneCleanup?.();
                errorCleanup?.();
            });

            // Get meeting ID from context for RAG queries
            const meetingId = meetingContext.id;

            if (meetingId) {
                // Use RAG-powered meeting query
                const result = await window.electronAPI?.ragQueryMeeting(meetingId, question);

                // If RAG not available (or failed), fall back to context-window chat
                if (result?.fallback) {
                    console.log("[MeetingChat] RAG unavailable, using context window fallback");
                    // Cleanup RAG listeners since we won't use them
                    tokenCleanup?.();
                    doneCleanup?.();
                    errorCleanup?.();

                    // FALLBACK LOGIC
                    const contextString = buildContextString();
                    const systemPrompt = `You are recalling a specific meeting. Answer questions ONLY about this meeting. Be concise (2-4 sentences). Sound natural, like a human recalling. If information is not present, say so briefly. Never guess.

${contextString}`;

                    streamBuffer.reset();
                    const oldTokenCleanup = window.electronAPI?.onGeminiStreamToken((token: string) => {
                        setChatState('streaming_response');
                        streamBuffer.appendToken(token, (content) => {
                            setMessages(prev => prev.map(msg =>
                                msg.id === assistantMessageId
                                    ? { ...msg, content }
                                    : msg
                            ));
                        });
                    });

                    const oldDoneCleanup = window.electronAPI?.onGeminiStreamDone(() => {
                        const finalContent = streamBuffer.getBufferedContent();
                        setMessages(prev => prev.map(msg =>
                            msg.id === assistantMessageId
                                ? { ...msg, content: finalContent, isStreaming: false, modelUsed: modelAtStart, durationMs: Date.now() - startedAt, source: 'fallback' }
                                : msg
                        ));
                        setChatState('idle');
                        streamBuffer.reset();
                        oldTokenCleanup?.();
                        oldDoneCleanup?.();
                        oldErrorCleanup?.();
                    });

                    const oldErrorCleanup = window.electronAPI?.onGeminiStreamError((error: string) => {
                        console.error('[MeetingChat] Gemini stream error (fallback):', error);
                        setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
                        setErrorMessage("Couldn't get a response. Please check your settings.");
                        setChatState('error');
                        streamBuffer.reset();
                        oldTokenCleanup?.();
                        oldDoneCleanup?.();
                        oldErrorCleanup?.();
                    });

                    await window.electronAPI?.streamGeminiChat(
                        question,
                        undefined,
                        systemPrompt,
                        { skipSystemPrompt: true, ignoreKnowledgeMode: true }
                    );
                }
            } else {
                // No meeting ID, standard fallback
                const contextString = buildContextString();
                const systemPrompt = `You are recalling a specific meeting. Answer questions ONLY about this meeting. Be concise (2-4 sentences). Sound natural, like a human recalling. If information is not present, say so briefly. Never guess.

${contextString}`;

                // Switch to Gemini streaming (RAF-batched)
                streamBuffer.reset();
                const oldTokenCleanup = window.electronAPI?.onGeminiStreamToken((token: string) => {
                    setChatState('streaming_response');
                    streamBuffer.appendToken(token, (content) => {
                        setMessages(prev => prev.map(msg =>
                            msg.id === assistantMessageId
                                ? { ...msg, content }
                                : msg
                        ));
                    });
                });

                const oldDoneCleanup = window.electronAPI?.onGeminiStreamDone(() => {
                    const finalContent = streamBuffer.getBufferedContent();
                    setMessages(prev => prev.map(msg =>
                        msg.id === assistantMessageId
                            ? { ...msg, content: finalContent, isStreaming: false, modelUsed: modelAtStart, durationMs: Date.now() - startedAt, source: 'fallback' }
                            : msg
                    ));
                    setChatState('idle');
                    streamBuffer.reset();
                    oldTokenCleanup?.();
                    oldDoneCleanup?.();
                    oldErrorCleanup?.();
                });

                const oldErrorCleanup = window.electronAPI?.onGeminiStreamError((error: string) => {
                    console.error('[MeetingChat] Gemini stream error:', error);
                    setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
                    setErrorMessage("Couldn't get a response. Please check your settings.");
                    setChatState('error');
                    streamBuffer.reset();
                    oldTokenCleanup?.();
                    oldDoneCleanup?.();
                    oldErrorCleanup?.();
                });

                await window.electronAPI?.streamGeminiChat(
                    question,
                    undefined,
                    systemPrompt,
                    { skipSystemPrompt: true, ignoreKnowledgeMode: true }
                );
            }

        } catch (error) {
            console.error('[MeetingChat] Error:', error);
            setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
            setErrorMessage("Something went wrong. Please try again.");
            setChatState('error');
        }
    }, [chatState, buildContextString, meetingContext]);

    if (!isOpen) return null;

    const isBusy = chatState === 'waiting_for_llm' || chatState === 'streaming_response';

    const handleSubmit = () => {
        if (!query.trim() || isBusy) return;
        const nextQuery = query.trim();
        setQuery('');
        submitQuestion(nextQuery);
    };

    return (
        <motion.section
            ref={chatWindowRef}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className={`mb-8 rounded-[24px] border shadow-sm overflow-hidden ${
                isLight
                    ? 'border-border-subtle bg-bg-card'
                    : 'border-white/10 bg-[#18181B] shadow-[0_18px_44px_rgba(0,0,0,0.35)]'
            }`}
        >
            <div className={`flex items-start justify-between gap-4 px-5 py-4 border-b ${
                isLight
                    ? 'border-border-subtle bg-bg-secondary/70'
                    : 'border-white/10 bg-white/[0.045]'
            }`}>
                <div className="min-w-0">
                    <div className="flex items-center gap-2 text-text-primary">
                        <img src={nativelyIcon} className="w-4 h-4 force-black-icon opacity-70" alt="Natively" />
                        <h2 className="text-sm font-semibold">Chat post-traitement</h2>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] font-medium text-text-secondary">
                        <span>{messages.length} message{messages.length > 1 ? 's' : ''}</span>
                        <span className="h-1 w-1 rounded-full bg-text-tertiary" />
                        <span>{chatState === 'idle' ? 'Ready' : chatState.replace(/_/g, ' ')}</span>
                    </div>
                </div>
                <div className="shrink-0">
                    <ModelSelector currentModel={currentModel} onSelectModel={handleModelSelect} placement="bottom" />
                </div>
            </div>

            <div className={`max-h-[420px] min-h-[180px] overflow-y-auto px-6 py-5 custom-scrollbar ${
                isLight ? 'bg-bg-card' : 'bg-[#111113]'
            }`}>
                {messages.length === 0 && chatState === 'idle' && (
                    <div className={`rounded-2xl border border-dashed px-5 py-6 text-sm ${
                        isLight
                            ? 'border-border-subtle bg-bg-secondary/60 text-text-secondary'
                            : 'border-white/10 bg-white/[0.04] text-slate-300'
                    }`}>
                        Pose une question sur cette réunion. L'historique restera dans cette carte.
                    </div>
                )}

                {messages.map((msg) => (
                    msg.role === 'user'
                        ? <UserMessage key={msg.id} content={msg.content} />
                        : <AssistantMessage key={msg.id} content={msg.content} isStreaming={msg.isStreaming} modelUsed={msg.modelUsed} durationMs={msg.durationMs} source={msg.source} />
                ))}

                {chatState === 'waiting_for_llm' && <TypingIndicator />}

                {errorMessage && (
                    <motion.div
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="text-[#FF6B6B] text-[13px] py-2"
                    >
                        {errorMessage}
                    </motion.div>
                )}

                <div ref={messagesEndRef} />
            </div>

            <div className={`border-t p-4 ${
                isLight
                    ? 'border-border-subtle bg-bg-secondary/70'
                    : 'border-white/10 bg-white/[0.045]'
            }`}>
                <div className="relative">
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                handleSubmit();
                            }
                        }}
                        placeholder="Demander quelque chose sur cette réunion..."
                        className={`w-full rounded-2xl border px-4 py-3 pr-12 text-sm placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent-primary/30 ${
                            isLight
                                ? 'border-border-subtle bg-bg-card text-text-primary'
                                : 'border-white/10 bg-[#1E1E22] text-slate-100'
                        }`}
                    />
                    <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={!query.trim() || isBusy}
                        className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-xl p-2 transition-all ${query.trim() && !isBusy ? 'bg-text-primary text-bg-primary hover:scale-105' : 'bg-bg-item-active text-text-tertiary'}`}
                    >
                        <ArrowUp size={16} />
                    </button>
                </div>
            </div>
        </motion.section>
    );
};

export default MeetingChatOverlay;
