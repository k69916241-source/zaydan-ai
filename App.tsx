import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getGetChatStatusQueryKey, getHealthCheckQueryKey, type ChatMessage, useGetChatStatus, useHealthCheck, useSearchWeb, useSendChatMessage } from '@workspace/api-client-react';
import { ArrowUp, Check, CircleHelp, Command, Compass, Globe2, Lightbulb, Menu, MessageSquare, Mic, MicOff, Moon, Plus, Settings2, ShieldCheck, Sparkles, Sun, Volume2, VolumeX } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Link,
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

type Conversation = { id: string; messages: ChatMessage[]; updatedAt: number };
type PreferredLanguage = 'English' | 'हिन्दी' | 'Hinglish';
type Preferences = { language: PreferredLanguage; appearance: 'light' | 'dark' };
const CHAT_STORAGE_KEY = 'zaydan-ai.chats.v1';
const PREF_STORAGE_KEY = 'zaydan-ai.preferences.v1';
const ACTIVE_CHAT_KEY = 'zaydan-ai.active-chat.v1';

function readStorage<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as { error?: unknown; message?: unknown };
    if (typeof candidate.error === 'string') return candidate.error;
    if (typeof candidate.message === 'string') {
      try {
        const parsed = JSON.parse(candidate.message) as { error?: unknown; message?: unknown };
        if (typeof parsed.error === 'string') return parsed.error;
        if (typeof parsed.message === 'string') return parsed.message;
      } catch {
        return candidate.message;
      }
      return candidate.message;
    }
  }
  return 'The message could not be sent. Please try again.';
}

type SpeechAlternativeLike = { transcript: string };
type SpeechResultLike = ArrayLike<SpeechAlternativeLike> & { isFinal: boolean };
type SpeechRecognitionEventLike = { results: ArrayLike<SpeechResultLike>; resultIndex: number };
type SpeechRecognitionErrorLike = { error: string };
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const speechWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function getSpeechLocale(language: string): string {
  return language === 'हिन्दी' || language === 'Hinglish' ? 'hi-IN' : 'en-IN';
}

function AppShell() {
  const [location, setLocation] = useLocation();
  const [conversations, setConversations] = useState<Conversation[]>(() => readStorage(CHAT_STORAGE_KEY, []));
  const [activeId, setActiveId] = useState<string | null>(() => readStorage<string | null>(ACTIVE_CHAT_KEY, null));
  const [preferences, setPreferences] = useState<Preferences>(() => readStorage(PREF_STORAGE_KEY, { language: 'English', appearance: 'light' }));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [requestError, setRequestError] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceListening, setVoiceListening] = useState(false);
  const [speakingMessageKey, setSpeakingMessageKey] = useState<string | null>(null);
  const [voiceModeEnabled, setVoiceModeEnabled] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceBaseDraftRef = useRef('');
  const voiceFinalTranscriptRef = useRef('');
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const voiceModeEnabledRef = useRef(false);
  const requestInFlightRef = useRef(false);
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), retry: 1 } });
  const chatStatus = useGetChatStatus({ query: { queryKey: getGetChatStatusQueryKey(), retry: 1 } });
  const chatMutation = useSendChatMessage();
  const searchMutation = useSearchWeb();
  const [searchQuery, setSearchQuery] = useState('');
  const isSettings = location === '/settings';
  const activeConversation = conversations.find((conversation) => conversation.id === activeId) ?? null;
  const messages = activeConversation?.messages ?? [];
  const busy = chatMutation.isPending;

  useEffect(() => {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(conversations));
  }, [conversations]);

  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_CHAT_KEY, JSON.stringify(activeId));
    else localStorage.removeItem(ACTIVE_CHAT_KEY);
  }, [activeId]);

  useEffect(() => {
    localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify(preferences));
    document.documentElement.classList.toggle('dark', preferences.appearance === 'dark');
  }, [preferences]);

  useEffect(() => () => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    try {
      recognition?.abort();
    } catch {
      // The recognizer may already have ended.
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      utteranceRef.current = null;
      window.speechSynthesis.cancel();
    }
  }, []);

  useEffect(() => {
    if (location === '/' && activeId && !conversations.some((conversation) => conversation.id === activeId)) {
      setActiveId(null);
    }
  }, [activeId, conversations, location]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, busy, requestError]);

  const orderedConversations = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations],
  );

  function startNewChat() {
    stopVoiceInput();
    stopSpeaking();
    searchMutation.reset();
    setSearchQuery('');
    setActiveId(null);
    setDraft('');
    setRequestError(null);
    setMobileOpen(false);
    setLocation('/');
    window.setTimeout(() => textareaRef.current?.focus(), 30);
  }

  function chooseConversation(id: string) {
    stopVoiceInput();
    stopSpeaking();
    searchMutation.reset();
    setSearchQuery('');
    setActiveId(id);
    setRequestError(null);
    setMobileOpen(false);
    setLocation('/');
  }

  function replaceConversation(id: string, update: (conversation: Conversation) => Conversation) {
    setConversations((current) => current.map((conversation) => conversation.id === id ? update(conversation) : conversation));
  }

  function requestAssistantReply(id: string, requestMessages: ChatMessage[]) {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    const recentMessages = requestMessages.slice(-24);
    const contextMessages = recentMessages[0]?.role === 'assistant'
      ? recentMessages.slice(1)
      : recentMessages;
    chatMutation.mutate({ data: { messages: contextMessages, preferredLanguage: preferences.language } }, {
      onSuccess: (response) => {
        replaceConversation(id, (conversation) => ({
          ...conversation,
          messages: [...conversation.messages, { role: 'assistant', content: response.message }],
          updatedAt: Date.now(),
        }));
        requestInFlightRef.current = false;
        if (voiceModeEnabledRef.current) {
          speakMessage(`${id}-${requestMessages.length}`, response.message);
        }
      },
      onError: (error) => {
        requestInFlightRef.current = false;
        setRequestError(getErrorMessage(error));
      },
    });
  }

  function sendMessage(event?: FormEvent, suppliedMessage?: string) {
    event?.preventDefault();
    const content = suppliedMessage?.trim() ?? draft.trim();
    if (!content || busy || requestInFlightRef.current) return;
    stopVoiceInput();
    const id = activeId ?? crypto.randomUUID();
    const nextMessages: ChatMessage[] = [...(activeConversation?.messages ?? []), { role: 'user', content }];
    const nextConversation: Conversation = { id, messages: nextMessages, updatedAt: Date.now() };
    setConversations((current) => current.some((item) => item.id === id)
      ? current.map((item) => item.id === id ? nextConversation : item)
      : [nextConversation, ...current]);
    setActiveId(id);
    setDraft('');
    setRequestError(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    requestAssistantReply(id, nextMessages);
  }

  function retryLastMessage() {
    if (!activeId || !activeConversation || busy || requestInFlightRef.current) return;
    setRequestError(null);
    requestAssistantReply(activeId, activeConversation.messages);
  }

  function searchTheWeb() {
    const query = draft.trim();
    if (!query || searchMutation.isPending) return;
    stopVoiceInput();
    setSearchQuery(query);
    searchMutation.mutate({ data: { query } });
  }

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  function changeDraft(value: string) {
    setDraft(value);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    }
  }

  function toggleVoiceInput() {
    if (voiceListening) {
      recognitionRef.current?.stop();
      return;
    }

    setVoiceError(null);
    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) {
      setVoiceError("Voice input isn't supported in this browser. You can type your message instead.");
      return;
    }

    recognitionRef.current?.abort();
    let recognition: SpeechRecognitionLike;
    try {
      recognition = new Recognition();
    } catch {
      setVoiceError('Voice input could not start. Check your browser microphone settings and try again.');
      return;
    }

    voiceBaseDraftRef.current = draft.trimEnd();
    voiceFinalTranscriptRef.current = '';
    recognition.lang = getSpeechLocale(preferences.language);
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) return;
      let interimTranscript = '';
      let finalTranscript = voiceFinalTranscriptRef.current;
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript ?? '';
        if (result?.isFinal) finalTranscript += transcript;
        else interimTranscript += transcript;
      }
      voiceFinalTranscriptRef.current = finalTranscript;
      const transcript = `${finalTranscript}${interimTranscript}`.trim();
      const baseDraft = voiceBaseDraftRef.current;
      changeDraft(baseDraft ? `${baseDraft}${transcript ? ' ' : ''}${transcript}` : transcript);
    };
    recognition.onerror = (event) => {
      setVoiceListening(false);
      if (event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setVoiceError('Microphone access was denied. Allow access in your browser settings and try again.');
      } else if (event.error === 'no-speech') {
        setVoiceError("I didn't hear any speech. Try again or type your message.");
      } else if (event.error === 'network') {
        setVoiceError('The browser speech service is unavailable right now. You can type your message instead.');
      } else {
        setVoiceError('Voice input stopped unexpectedly. You can type your message instead.');
      }
    };
    recognition.onend = () => {
      setVoiceListening(false);
      if (recognitionRef.current === recognition) recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    setVoiceListening(true);
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setVoiceListening(false);
      setVoiceError('Voice input could not start. Check your browser microphone settings and try again.');
    }
  }

  function stopVoiceInput() {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      try {
        recognition.abort();
      } catch {
        // The recognizer may already have ended.
      }
    }
    setVoiceListening(false);
  }

  function stopSpeaking() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      utteranceRef.current = null;
      window.speechSynthesis.cancel();
    }
    setSpeakingMessageKey(null);
  }

  function toggleVoiceMode() {
    const enabled = !voiceModeEnabledRef.current;
    voiceModeEnabledRef.current = enabled;
    setVoiceModeEnabled(enabled);
    if (!enabled) stopSpeaking();
  }

  function toggleSpeechLanguage() {
    setPreferences((current) => ({
      ...current,
      language: current.language === 'English' ? 'हिन्दी' : 'English',
    }));
  }

  function speakMessage(messageKey: string, text: string) {
    if (speakingMessageKey === messageKey) {
      stopSpeaking();
      return;
    }
    if (
      typeof window === 'undefined'
      || !('speechSynthesis' in window)
      || typeof SpeechSynthesisUtterance === 'undefined'
    ) {
      setVoiceError('Audio output is not supported in this browser. The response text is still available.');
      return;
    }

    utteranceRef.current = null;
    window.speechSynthesis.cancel();
    const locale = getSpeechLocale(preferences.language);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = locale;
    const localePrefix = locale.slice(0, 2).toLowerCase();
    const voices = window.speechSynthesis.getVoices();
    utterance.voice = voices.find((voice) => voice.lang.toLowerCase() === locale.toLowerCase())
      ?? voices.find((voice) => voice.lang.toLowerCase().startsWith(localePrefix))
      ?? null;
    utterance.onend = () => {
      if (utteranceRef.current === utterance) {
        utteranceRef.current = null;
        setSpeakingMessageKey(null);
      }
    };
    utterance.onerror = () => {
      if (utteranceRef.current === utterance) {
        utteranceRef.current = null;
        setSpeakingMessageKey(null);
        setVoiceError('Audio playback failed. The response text is still available.');
      }
    };
    utteranceRef.current = utterance;
    setVoiceError(null);
    setSpeakingMessageKey(messageKey);
    window.speechSynthesis.speak(utterance);
  }

  const speechOutputSupported = typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof SpeechSynthesisUtterance !== 'undefined';
  const voiceStatusText = voiceListening
    ? 'Listening…'
    : busy
      ? 'Processing…'
      : speakingMessageKey
        ? 'Speaking…'
        : voiceModeEnabled
          ? 'Voice Mode on'
          : speechOutputSupported
            ? 'Voice Mode off'
            : 'Speech output unavailable';

  const status = chatStatus.data;
  const statusText = chatStatus.isLoading ? 'Checking AI availability' : chatStatus.isError ? 'Status unavailable' : status?.available ? 'AI connected' : 'AI not connected';

  return (
    <div className="app-shell">
      <button aria-label="Close navigation" className={`sidebar-backdrop ${mobileOpen ? 'is-open' : ''}`} data-testid="button-close-sidebar" onClick={() => setMobileOpen(false)} />
      <aside className={`sidebar ${mobileOpen ? 'is-open' : ''}`} data-testid="sidebar-navigation">
        <Link href="/" className="brand-lockup" data-testid="link-home-brand" onClick={() => { setLocation('/'); setMobileOpen(false); }}>
          <span className="brand-mark">Z</span>
          <span><span className="brand-name">zaydan ai</span><span className="brand-caption">A LITTLE MORE CLARITY</span></span>
        </Link>
        <button className="new-chat" data-testid="button-new-chat" onClick={startNewChat}>
          <Plus size={16} strokeWidth={2.1} /> New chat
        </button>
        <div className="history-heading" data-testid="label-chat-history">Chat history</div>
        <div className="history-list" data-testid="list-chat-history">
          {orderedConversations.length === 0 ? (
            <div className="history-empty" data-testid="text-history-empty">Your conversations will appear here, saved only on this device.</div>
          ) : orderedConversations.map((conversation) => {
            const title = conversation.messages.find((message) => message.role === 'user')?.content ?? 'New conversation';
            return (
              <button key={conversation.id} className={`history-item ${conversation.id === activeId && !isSettings ? 'is-active' : ''}`} data-testid={`button-history-${conversation.id}`} onClick={() => chooseConversation(conversation.id)}>
                <MessageSquare size={14} strokeWidth={1.7} />
                <span>{title}</span>
              </button>
            );
          })}
        </div>
        <div className="sidebar-footer">
          <Link href="/settings" className={`side-link ${isSettings ? 'is-active' : ''}`} data-testid="link-settings" onClick={() => { setLocation('/settings'); setMobileOpen(false); }}>
            <Settings2 size={16} strokeWidth={1.8} /> Settings
          </Link>
          <p className="creator-note">Made with care by Armaan Hussain</p>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button className="mobile-menu" data-testid="button-open-sidebar" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={20} /></button>
            <span className="topbar-title">{isSettings ? 'Settings' : 'A clear headspace'}</span>
          </div>
          <div className="topbar-left">
            <span className="status-pill" data-testid="status-ai-availability">
              <span className="status-dot" style={{ background: status?.available ? '#6b917e' : undefined }} />
              {statusText}
            </span>
            <span className="health-label" data-testid="status-service-health">
              {health.isLoading ? 'Connecting…' : health.data?.status ?? (health.isError ? 'Service unavailable' : '')}
            </span>
          </div>
        </header>

        {isSettings ? (
          <SettingsPage
            statusMessage={status?.message}
            statusAvailable={status?.available ?? false}
            statusLoading={chatStatus.isLoading}
            preferences={preferences}
            onChange={setPreferences}
          />
        ) : (
          <section className="chat-stage" aria-label="Conversation">
            <div className="messages-scroll" data-testid="conversation-scroll">
              {messages.length === 0 ? (
                <div className="welcome" data-testid="welcome-screen">
                  <div className="welcome-orbit"><Sparkles size={25} strokeWidth={1.5} /></div>
                  <h1 data-testid="text-welcome-title">I'm Zaydan.</h1>
                  <p className="welcome-copy" data-testid="text-welcome-copy">Ask me what's on your mind. I'll keep it clear and tell you when I don't know.</p>
                  <p className="suggestion-label">A few ways to begin</p>
                  <div className="suggestions">
                    <button className="suggestion" data-testid="button-prompt-explain" disabled={busy} onClick={() => sendMessage(undefined, 'Explain a difficult topic in simple words.')}>
                      <Lightbulb size={17} />
                      <span className="suggestion-copy"><strong>Explain Something</strong><span>Explain a difficult topic in simple words.</span></span>
                    </button>
                    <button className="suggestion" data-testid="button-prompt-write" disabled={busy} onClick={() => sendMessage(undefined, 'Help me write or improve something.')}>
                      <MessageSquare size={17} />
                      <span className="suggestion-copy"><strong>Help Me Write</strong><span>Help me write or improve something.</span></span>
                    </button>
                    <button className="suggestion" data-testid="button-prompt-solve" disabled={busy} onClick={() => sendMessage(undefined, 'Help me think through a challenging problem.')}>
                      <CircleHelp size={17} />
                      <span className="suggestion-copy"><strong>Solve a Problem</strong><span>Help me think through a challenging problem.</span></span>
                    </button>
                    <button className="suggestion" data-testid="button-prompt-idea" disabled={busy} onClick={() => sendMessage(undefined, 'Help me develop a new idea.')}>
                      <Compass size={17} />
                      <span className="suggestion-copy"><strong>Explore an Idea</strong><span>Help me develop a new idea.</span></span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="message-column" data-testid="message-list">
                  {messages.map((message, index) => {
                    const messageKey = `${activeId}-${index}`;
                    const isSpeaking = speakingMessageKey === messageKey;
                    return (
                    <article className={`message-row ${message.role}`} data-testid={`message-${message.role}-${index}`} key={messageKey}>
                      {message.role === 'assistant' && <div className="assistant-avatar" aria-hidden="true">Z</div>}
                      <div className="message-body">
                        <div className="message-role">{message.role === 'user' ? 'You' : 'Zaydan'}</div>
                        <div className="message-content" data-testid={`text-message-${index}`}>{message.content}</div>
                        {message.role === 'assistant' && (
                          <div className="message-actions">
                            <button
                              type="button"
                              className="voice-action message-voice-action"
                              aria-label={isSpeaking ? 'Stop speaking' : 'Read response aloud'}
                              title={speechOutputSupported ? (isSpeaking ? 'Stop speaking' : 'Read response aloud') : 'Speech output is not supported in this browser; text remains available.'}
                              disabled={!speechOutputSupported}
                              onClick={() => speakMessage(messageKey, message.content)}
                            >
                              {isSpeaking ? <VolumeX size={15} /> : <Volume2 size={15} />}
                              <span>{isSpeaking ? 'Stop' : 'Listen'}</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </article>
                    );
                  })}
                  {busy && <div className="message-row assistant" data-testid="status-assistant-loading"><div className="assistant-avatar">Z</div><div className="message-body"><div className="message-role">Zaydan is thinking</div><div className="loading-dots" aria-label="Waiting for a response"><span /><span /><span /></div></div></div>}
                  {requestError && <div className="error-notice" role="alert" data-testid="status-chat-error"><CircleHelp size={16} /><span>{requestError}</span><button className="error-retry" data-testid="button-retry-message" onClick={retryLastMessage}>Try again</button></div>}
                  <div ref={messagesEndRef} />
                </div>
              )}
              {(searchQuery || searchMutation.isPending) && (
                <section className="search-results-panel" data-testid="panel-web-search-results" aria-live="polite">
                  <div className="search-results-heading">
                    <Globe2 size={16} />
                    <strong>Web results</strong>
                    {searchQuery && <span>for “{searchQuery}”</span>}
                  </div>
                  {searchMutation.isPending && <p className="search-state">Searching the web…</p>}
                  {searchMutation.error && (
                    <p className="search-state search-state-error" role="alert">{getErrorMessage(searchMutation.error)}</p>
                  )}
                  {searchMutation.data && searchMutation.data.results.length === 0 && (
                    <p className="search-state">No results were returned. Try a different search.</p>
                  )}
                  {searchMutation.data?.results.map((result, index) => (
                    <article className="search-result" data-testid={`web-search-result-${index}`} key={`${result.url}-${index}`}>
                      <a href={result.url} target="_blank" rel="noopener noreferrer">
                        <strong>{result.title}</strong>
                        <span className="search-result-url">{result.url}</span>
                      </a>
                      <p>{result.snippet}</p>
                    </article>
                  ))}
                </section>
              )}
            </div>
            <div className="composer-wrap">
              <div className="voice-mode-toolbar" role="group" aria-label="Voice conversation controls">
                <button
                  className={`voice-mode-toggle ${voiceModeEnabled ? 'is-enabled' : ''}`}
                  data-testid="button-toggle-voice-mode"
                  type="button"
                  aria-pressed={voiceModeEnabled}
                  title={speechOutputSupported ? 'Automatically read each new response aloud' : 'Speech output is not supported in this browser'}
                  disabled={!speechOutputSupported}
                  onClick={toggleVoiceMode}
                >
                  {voiceModeEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
                  <span>Voice Mode</span>
                  <strong>{voiceModeEnabled ? 'On' : 'Off'}</strong>
                </button>
                <button
                  className="voice-language-toggle"
                  data-testid="button-toggle-speech-language"
                  type="button"
                  aria-label={`Speech and response language: ${preferences.language}. Switch to ${preferences.language === 'English' ? 'Hindi' : 'English'}.`}
                  title="Switch speech recognition, speech playback, and response language"
                  disabled={voiceListening || busy}
                  onClick={toggleSpeechLanguage}
                >
                  <span>Speech</span>
                  <strong>{preferences.language === 'English' ? 'English' : preferences.language === 'हिन्दी' ? 'हिन्दी' : 'Hinglish'}</strong>
                  <span aria-hidden="true">↔</span>
                </button>
                <div className="voice-live-state" role="status" aria-live="polite">
                  <span className={`voice-state-dot ${voiceListening ? 'is-listening' : speakingMessageKey ? 'is-speaking' : busy ? 'is-processing' : ''}`} />
                  <span>{voiceStatusText}</span>
                </div>
                {voiceListening && (
                  <button className="voice-stop-button" type="button" onClick={stopVoiceInput}>
                    Stop listening
                  </button>
                )}
                {speakingMessageKey && (
                  <button className="voice-stop-button" data-testid="button-stop-speaking" type="button" onClick={stopSpeaking}>
                    Stop speaking
                  </button>
                )}
              </div>
              <form className="composer" onSubmit={sendMessage} data-testid="form-chat-composer">
                <textarea
                  ref={textareaRef}
                  data-testid="input-chat-message"
                  aria-label="Write a message"
                  placeholder="Message Zaydan…"
                  value={draft}
                  rows={1}
                  onChange={(event) => changeDraft(event.target.value)}
                  onKeyDown={handleTextareaKeyDown}
                  maxLength={6000}
                />
                <div className="composer-controls">
                  <button
                    className="search-action"
                    data-testid="button-search-web"
                    type="button"
                    aria-label={searchMutation.isPending ? 'Searching the web' : 'Search the web'}
                    title="Search the web separately from chat"
                    disabled={!draft.trim() || searchMutation.isPending}
                    onClick={searchTheWeb}
                  >
                    <Globe2 size={16} />
                    <span>{searchMutation.isPending ? 'Searching' : 'Search'}</span>
                  </button>
                  <button
                    className={`voice-action composer-voice-action ${voiceListening ? 'is-active' : ''}`}
                    data-testid="button-voice-input"
                    type="button"
                    aria-label={voiceListening ? 'Stop voice input' : 'Start voice input'}
                    aria-pressed={voiceListening}
                    title="Speak a message; it will appear in the text box before sending."
                    disabled={busy}
                    onClick={toggleVoiceInput}
                  >
                    {voiceListening ? <MicOff size={17} /> : <Mic size={17} />}
                  </button>
                  <button className="send-button" data-testid="button-send-message" aria-label="Send message" disabled={!draft.trim() || busy} type="submit">
                    {busy ? <span className="send-loading" aria-hidden="true" /> : <ArrowUp size={18} strokeWidth={2.2} />}
                  </button>
                </div>
              </form>
              {voiceError && <div className="composer-feedback" role="status" aria-live="polite">{voiceError}</div>}
              <div className="composer-footnote">
                <span className="local-note"><ShieldCheck size={12} /> Chats stay on this device. No saved memory.</span>
                <span><Command size={10} /> Enter to send · Shift + Enter for a new line</span>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function SettingsPage({
  statusMessage,
  statusAvailable,
  statusLoading,
  preferences,
  onChange,
}: {
  statusMessage?: string;
  statusAvailable: boolean;
  statusLoading: boolean;
  preferences: Preferences;
  onChange: (next: Preferences) => void;
}) {
  return (
    <section className="settings-page" data-testid="page-settings">
      <div className="settings-kicker">Your space</div>
      <h1 className="settings-title">Settings</h1>
      <p className="settings-intro">A few small choices for how Zaydan feels. These preferences are saved in this browser, not on a server.</p>

      <div className="settings-card">
        <div className="settings-card-header"><h2>Personalize your experience</h2><p>Choose what feels most comfortable. Your language preference guides replies and speech.</p></div>
        <div className="setting-row">
          <div><span className="setting-label">Preferred language</span><p className="setting-description">Choose the language Zaydan uses for replies and voice.</p></div>
          <select className="setting-select" data-testid="select-language-preference" value={preferences.language} onChange={(event) => onChange({ ...preferences, language: event.target.value as PreferredLanguage })}>
            <option>English</option><option>हिन्दी</option><option>Hinglish</option>
          </select>
        </div>
        <div className="setting-row">
          <div><span className="setting-label">Appearance</span><p className="setting-description">Choose a comfortable reading surface.</p></div>
          <button className="theme-toggle" data-testid="button-toggle-appearance" onClick={() => onChange({ ...preferences, appearance: preferences.appearance === 'light' ? 'dark' : 'light' })}>
            {preferences.appearance === 'light' ? <Moon size={14} /> : <Sun size={14} />}
            {preferences.appearance === 'light' ? 'Light' : 'Dark'}
          </button>
        </div>
      </div>

      <div className="availability-card" data-testid="card-ai-availability">
        {statusAvailable ? <Check size={17} /> : <CircleHelp size={17} />}
        <div>
          <strong>{statusLoading ? 'Checking assistant availability' : statusAvailable ? 'Assistant connected' : 'AI is not connected yet'}</strong>
          <p>{statusLoading ? 'Checking the server status.' : statusMessage ?? 'Connection details are not available right now.'} Your chat history and preferences remain saved only in this browser.</p>
        </div>
      </div>
    </section>
  );
}

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={AppShell} />
        <Route path="/settings" component={AppShell} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
