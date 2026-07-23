import {
  AtSign,
  Camera,
  CameraOff,
  Check,
  CheckCheck,
  CircleHelp,
  Copy,
  CornerUpLeft,
  Download,
  Hash,
  Headphones,
  Link2,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  Paperclip,
  Pencil,
  PhoneOff,
  Plus,
  Radio,
  Search,
  ScanQrCode,
  Send,
  Settings,
  Sliders,
  Sparkles,
  Trash2,
  Users,
  UserPlus,
  Video,
  Volume2,
  VolumeX,
  Waves,
  X,
} from 'lucide-react';
import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { createMicPipeline, type MicPipeline } from './audio/micPipeline';
import { createSpeakingMonitor } from './audio/speaking';
import { captureScreenSource, bitrateForQuality, RESOLUTION_PRESETS, FPS_PRESETS, type ScreenQuality } from './desktopCapture';
import type { DesktopSource } from './types/rift-desktop';
import { AttachmentView } from './AttachmentView';
import { base64ToBytes, bytesToBase64, saveAttachment } from './files';
import { Onboarding } from './Onboarding';
import { downloadQrPng, packSignal, unpackSignal } from './pairing';
import { QrScanner } from './QrScanner';
import { answerPairingLink, createPairingLink } from './relayPairing';
import { Attachment, defaultChannels, defaultMessages, Message, useLocalStorageState } from './storage';
import { useMandatoryUpdater } from './useMandatoryUpdater';

type SignalMode = 'idle' | 'host-offer' | 'guest-offer' | 'host-answer';

type PendingTransfer = {
  attachment: Attachment;
  author: string;
  channelId: string;
  channelName: string;
  chunks: Uint8Array[];
};

const MAX_FILE_SIZE = 8 * 1024 * 1024;
const FILE_CHUNK_SIZE = 12 * 1024;
// Bound RNNoise WASM/AudioWorklet startup so a slow WebView or an underpowered
// machine falls back to browser suppression instead of stalling call start.
const RNNOISE_START_TIMEOUT_MS = 8_000;
// Bounded ICE restart: how many times to renegotiate ICE over the still-open
// data channel before declaring the direct route unrecoverable.
const MAX_ICE_RESTARTS = 4;
// Delivery receipts only ever move forward: sent -> delivered -> read.
const STATUS_RANK: Record<string, number> = { sent: 0, delivered: 1, read: 2 };
const mergeStatus = (current: string | undefined, next: string) =>
  (STATUS_RANK[next] ?? 0) >= (STATUS_RANK[current ?? 'sent'] ?? 0) ? next : current;
const TYPING_THROTTLE_MS = 3_000;
const WEBRTC_UNAVAILABLE_MESSAGE = 'Это встроенное окно не поддерживает WebRTC. Открой http://localhost:5173 в Chrome или Edge либо запусти Windows-приложение RIFT.';

const servers = [
  { label: 'RF', active: true },
  { label: '404', active: false },
  { label: '∆', active: false },
];

function waitForIce(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const handler = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', handler);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', handler);
    window.setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', handler);
      resolve();
    }, 7000);
  });
}

function getPeerConnectionConstructor() {
  const constructor = window.RTCPeerConnection;
  if (typeof constructor !== 'function') {
    throw new Error(WEBRTC_UNAVAILABLE_MESSAGE);
  }
  return constructor;
}

function App() {
  const updater = useMandatoryUpdater();
  const [profileName, setProfileName] = useLocalStorageState('rift.profileName', 'Ты');
  const [channels, setChannels] = useLocalStorageState('rift.channels', defaultChannels);
  const [activeChannelId, setActiveChannelId] = useLocalStorageState('rift.activeChannel', 'general');
  const [messagesByChannel, setMessagesByChannel] = useLocalStorageState<Record<string, Message[]>>('rift.messages', defaultMessages);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; author: string; text: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [remoteTypingChannel, setRemoteTypingChannel] = useState<string | null>(null);
  const [accentHue, setAccentHue] = useLocalStorageState('rift.accentHue', 78);
  const [bubbleStyle, setBubbleStyle] = useLocalStorageState('rift.bubbles', false);
  const typingSentAtRef = useRef(0);
  const typingClearTimerRef = useRef<number | null>(null);
  const pendingReadRef = useRef(new Map<string, Set<string>>());
  const [channelModalOpen, setChannelModalOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [profileDraft, setProfileDraft] = useState(profileName);
  const [onboardingOpen, setOnboardingOpen] = useLocalStorageState('rift.onboardingOpen', true);
  const [signalOpen, setSignalOpen] = useState(false);
  const [signalMode, setSignalMode] = useState<SignalMode>('idle');
  const [signalText, setSignalText] = useState('');
  const [generatedSignal, setGeneratedSignal] = useState('');
  const [scannerMode, setScannerMode] = useState<'offer' | 'answer' | null>(null);
  const [shareLink, setShareLink] = useState('');
  const [linkDraft, setLinkDraft] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);
  const [status, setStatus] = useState('не подключено');
  const [error, setError] = useState('');
  const [micOn, setMicOn] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [noiseSuppressionOn, setNoiseSuppressionOn] = useLocalStorageState('rift.rnnoise', true);
  const [micGain, setMicGain] = useLocalStorageState('rift.micGain', 1);
  const [inputDeviceId, setInputDeviceId] = useLocalStorageState('rift.micDevice', '');
  const [outputDeviceId, setOutputDeviceId] = useLocalStorageState('rift.speaker', '');
  const [inputMode, setInputMode] = useLocalStorageState<'voice' | 'ptt'>('rift.inputMode', 'voice');
  const [pttActive, setPttActive] = useState(false);
  const [vadAuto, setVadAuto] = useLocalStorageState('rift.vadAuto', true);
  const [vadThreshold, setVadThreshold] = useLocalStorageState('rift.vadThreshold', 14);
  const [echoCancellation, setEchoCancellation] = useLocalStorageState('rift.aec', true);
  const [autoGain, setAutoGain] = useLocalStorageState('rift.agc', true);
  const [micTestOn, setMicTestOn] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);
  const pttEnabled = inputMode === 'ptt';
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [audioModalOpen, setAudioModalOpen] = useState(false);
  const [screenPickerOpen, setScreenPickerOpen] = useState(false);
  const [screenSources, setScreenSources] = useState<DesktopSource[]>([]);
  const [screenTab, setScreenTab] = useState<'window' | 'screen'>('window');
  const [screenLoading, setScreenLoading] = useState(false);
  const [screenQuality, setScreenQuality] = useLocalStorageState<ScreenQuality>('rift.screenQuality', { height: 1080, fps: 30, audio: true });
  const [screenCodec, setScreenCodec] = useLocalStorageState<'auto' | 'VP9' | 'H264' | 'AV1'>('rift.screenCodec', 'auto');
  const screenSourceIdRef = useRef<string | null>(null);
  const screenAudioTransceiverRef = useRef<RTCRtpTransceiver | null>(null);
  const remotePrimaryAudioRef = useRef<MediaStreamTrack | null>(null);
  const mediaBusyRef = useRef(false);
  const [remoteAudioOn, setRemoteAudioOn] = useState(false);
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [remoteSpeaking, setRemoteSpeaking] = useState(false);
  const [remoteVolume, setRemoteVolume] = useLocalStorageState('rift.remoteVolume', 1);
  const [deafened, setDeafened] = useState(false);
  const [remoteVideoOn, setRemoteVideoOn] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [callMinimized, setCallMinimized] = useState(false);
  const [transferLabel, setTransferLabel] = useState('');
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const rawMicTrackRef = useRef<MediaStreamTrack | null>(null);
  const micPipelineRef = useRef<MicPipeline | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef(new MediaStream());
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteTileRef = useRef<HTMLDivElement>(null);
  const localTileRef = useRef<HTMLDivElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingTransfersRef = useRef(new Map<string, PendingTransfer>());
  const pairingStopRef = useRef<null | (() => void)>(null);
  const politePeerRef = useRef(false);
  const makingMediaOfferRef = useRef(false);
  const handledLinksRef = useRef(new Set<string>());
  const disconnectedTimerRef = useRef<number | null>(null);
  const iceRestartAttemptsRef = useRef(0);
  const activeChannelRef = useRef(activeChannelId);
  const activeChannel = channels.find((channel) => channel.id === activeChannelId) || channels[0];
  const messages = messagesByChannel[activeChannel?.id] || [];
  const packedSignal = useMemo(() => generatedSignal ? packSignal(generatedSignal) : '', [generatedSignal]);

  const attachCallStreams = useCallback(() => {
    // The local preview shows the screen share while it is active; remounting
    // the call stage (minimize/restore) must not fall back to the camera stream.
    const localPreview = screenStreamRef.current || localStreamRef.current;
    if (localVideoRef.current && localVideoRef.current.srcObject !== localPreview) {
      localVideoRef.current.srcObject = localPreview;
    }
    if (remoteVideoRef.current && remoteVideoRef.current.srcObject !== remoteStreamRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
    }
    if (remoteAudioRef.current && remoteAudioRef.current.srcObject !== remoteStreamRef.current) {
      remoteAudioRef.current.srcObject = remoteStreamRef.current;
    }
    void remoteAudioRef.current?.play().catch(() => {
      // WebView may wait for the next user click before allowing remote audio.
    });
  }, []);

  const sendCurrentMediaOffer = useCallback(async (options?: RTCOfferOptions) => {
    const pc = pcRef.current;
    const channel = channelRef.current;
    if (!pc || channel?.readyState !== 'open' || pc.signalingState !== 'stable' || makingMediaOfferRef.current) return;
    makingMediaOfferRef.current = true;
    try {
      await pc.setLocalDescription(await pc.createOffer(options));
      channel.send(JSON.stringify({ type: 'rtc-offer', description: pc.localDescription }));
    } catch (offerError) {
      // A closing channel or a racing negotiation must not take the call down.
      console.warn('[RIFT] media offer failed', offerError);
    } finally {
      makingMediaOfferRef.current = false;
    }
  }, []);

  // Recover a dropped media route by renegotiating ICE over the still-open
  // encrypted data channel. The impolite peer drives the restart offer; the
  // polite peer asks for one. If the channel is gone there is no signaling
  // path left, so recovery is impossible without re-pairing.
  const attemptIceRestart = useCallback(() => {
    const channel = channelRef.current;
    if (channel?.readyState !== 'open') return;
    if (politePeerRef.current) {
      channel.send(JSON.stringify({ type: 'rtc-ice-restart-request' }));
    } else {
      void sendCurrentMediaOffer({ iceRestart: true });
    }
  }, [sendCurrentMediaOffer]);

  useEffect(() => {
    activeChannelRef.current = activeChannelId;
  }, [activeChannelId]);

  const receiveMessage = useCallback(async (event: MessageEvent) => {
    try {
      const payload = JSON.parse(event.data) as {
        type: string;
        id?: string;
        ids?: string[];
        text?: string;
        author?: string;
        channelId?: string;
        channelName?: string;
        transferId?: string;
        attachment?: Attachment;
        chunk?: string;
        description?: RTCSessionDescriptionInit;
        audio?: boolean;
        video?: boolean;
        status?: string;
        emoji?: string;
        add?: boolean;
        replyTo?: { id: string; author: string; text: string };
      };
      if (payload.type === 'call-state') {
        setRemoteAudioOn(Boolean(payload.audio));
        setRemoteVideoOn(Boolean(payload.video));
        return;
      }
      if (payload.type === 'rtc-renegotiate-request' || payload.type === 'rtc-ice-restart-request') {
        if (politePeerRef.current) return;
        const offerOptions = payload.type === 'rtc-ice-restart-request' ? { iceRestart: true } : undefined;
        void (async () => {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            if (pcRef.current?.signalingState === 'stable') {
              await sendCurrentMediaOffer(offerOptions);
              return;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 100));
          }
        })();
        return;
      }
      if (payload.type === 'rtc-offer' && payload.description && pcRef.current) {
        const pc = pcRef.current;
        const collision = pc.signalingState !== 'stable';
        if (collision && !politePeerRef.current) return;
        if (collision) await pc.setLocalDescription({ type: 'rollback' });
        await pc.setRemoteDescription(payload.description);
        await pc.setLocalDescription(await pc.createAnswer());
        if (channelRef.current?.readyState === 'open') {
          channelRef.current.send(JSON.stringify({ type: 'rtc-answer', description: pc.localDescription }));
        }
        return;
      }
      if (payload.type === 'rtc-answer' && payload.description && pcRef.current?.signalingState === 'have-local-offer') {
        await pcRef.current.setRemoteDescription(payload.description);
        return;
      }
      if (payload.type === 'typing' && payload.channelId) {
        setRemoteTypingChannel(payload.channelId);
        if (typingClearTimerRef.current !== null) window.clearTimeout(typingClearTimerRef.current);
        typingClearTimerRef.current = window.setTimeout(() => setRemoteTypingChannel(null), 6_000);
        return;
      }
      if (payload.type === 'msg-ack' && payload.channelId && payload.status) {
        const ackIds = new Set(payload.ids || (payload.id ? [payload.id] : []));
        if (!ackIds.size) return;
        setMessagesByChannel((all) => ({
          ...all,
          [payload.channelId!]: (all[payload.channelId!] || []).map((message) =>
            ackIds.has(message.id)
              ? { ...message, status: mergeStatus(message.status, payload.status!) as Message['status'] }
              : message),
        }));
        return;
      }
      if (payload.type === 'message-edit' && payload.id && payload.channelId && payload.text) {
        setMessagesByChannel((all) => ({
          ...all,
          [payload.channelId!]: (all[payload.channelId!] || []).map((message) =>
            message.id === payload.id ? { ...message, text: payload.text!, edited: true } : message),
        }));
        return;
      }
      if (payload.type === 'message-delete' && payload.id && payload.channelId) {
        setMessagesByChannel((all) => ({
          ...all,
          [payload.channelId!]: (all[payload.channelId!] || []).filter((message) => message.id !== payload.id),
        }));
        return;
      }
      if (payload.type === 'reaction' && payload.id && payload.channelId && payload.emoji) {
        const author = payload.author || 'Собеседник';
        setMessagesByChannel((all) => ({
          ...all,
          [payload.channelId!]: (all[payload.channelId!] || []).map((message) => {
            if (message.id !== payload.id) return message;
            const reactions = { ...(message.reactions || {}) };
            const names = new Set(reactions[payload.emoji!] || []);
            if (payload.add) names.add(author);
            else names.delete(author);
            if (names.size) reactions[payload.emoji!] = [...names];
            else delete reactions[payload.emoji!];
            return { ...message, reactions };
          }),
        }));
        return;
      }
      if (payload.type === 'message' && payload.text) {
        const targetId = payload.channelId || activeChannelRef.current;
        const messageId = payload.id || crypto.randomUUID();
        if (payload.channelName) {
          setChannels((items) => items.some((item) => item.id === targetId)
            ? items
            : [...items, { id: targetId, name: payload.channelName! }]);
        }
        setMessagesByChannel((all) => ({
          ...all,
          [targetId]: [...(all[targetId] || []), {
            id: messageId,
            author: payload.author || 'Собеседник',
            text: payload.text!,
            time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
            replyTo: payload.replyTo,
          }],
        }));
        setRemoteTypingChannel(null);
        const visibleNow = targetId === activeChannelRef.current && document.hasFocus();
        if (channelRef.current?.readyState === 'open') {
          channelRef.current.send(JSON.stringify({
            type: 'msg-ack', id: messageId, channelId: targetId, status: visibleNow ? 'read' : 'delivered',
          }));
        }
        if (!visibleNow) {
          const pending = pendingReadRef.current.get(targetId) || new Set<string>();
          pending.add(messageId);
          pendingReadRef.current.set(targetId, pending);
        }
        if (targetId !== activeChannelRef.current) {
          setUnread((items) => ({ ...items, [targetId]: (items[targetId] || 0) + 1 }));
        }
      }
      if (payload.type === 'file-meta' && payload.transferId && payload.attachment) {
        pendingTransfersRef.current.set(payload.transferId, {
          attachment: payload.attachment,
          author: payload.author || 'Собеседник',
          channelId: payload.channelId || activeChannelRef.current,
          channelName: payload.channelName || 'файлы',
          chunks: [],
        });
        setTransferLabel(`получаем ${payload.attachment.name}…`);
      }
      if (payload.type === 'file-chunk' && payload.transferId && payload.chunk) {
        pendingTransfersRef.current.get(payload.transferId)?.chunks.push(base64ToBytes(payload.chunk));
      }
      if (payload.type === 'file-end' && payload.transferId) {
        const transfer = pendingTransfersRef.current.get(payload.transferId);
        if (!transfer) return;
        const parts = transfer.chunks.map((chunk) =>
          chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer);
        const blob = new Blob(parts, { type: transfer.attachment.type });
        await saveAttachment(transfer.attachment.id, blob);
        setChannels((items) => items.some((item) => item.id === transfer.channelId)
          ? items
          : [...items, { id: transfer.channelId, name: transfer.channelName }]);
        setMessagesByChannel((all) => ({
          ...all,
          [transfer.channelId]: [...(all[transfer.channelId] || []), {
            id: crypto.randomUUID(),
            author: transfer.author,
            text: '',
            time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
            attachment: transfer.attachment,
          }],
        }));
        if (transfer.channelId !== activeChannelRef.current) {
          setUnread((items) => ({ ...items, [transfer.channelId]: (items[transfer.channelId] || 0) + 1 }));
        }
        pendingTransfersRef.current.delete(payload.transferId);
        setTransferLabel('');
      }
    } catch (packetError) {
      console.error('[RIFT] data-channel packet failed', packetError);
    }
  }, [sendCurrentMediaOffer]);

  const bindChannel = useCallback((channel: RTCDataChannel) => {
    channelRef.current = channel;
    channel.onopen = () => {
      if (channelRef.current === channel) setStatus('прямое соединение');
    };
    channel.onclose = () => {
      if (channelRef.current === channel) setStatus('соединение закрыто');
    };
    channel.onerror = () => {
      if (channelRef.current === channel) setError('Ошибка канала сообщений');
    };
    channel.onmessage = receiveMessage;
  }, [receiveMessage]);

  const createPeer = useCallback((polite = false) => {
    if (pcRef.current) {
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
    }
    screenAudioTransceiverRef.current = null; // belonged to the old connection
    remotePrimaryAudioRef.current = null;
    const PeerConnection = getPeerConnectionConstructor();
    const pc = new PeerConnection({
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      ],
    });
    politePeerRef.current = polite;
    pcRef.current = pc;
    if (!polite) {
      const audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
      const videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
      const currentAudio = localStreamRef.current?.getAudioTracks()[0];
      const currentVideo = localStreamRef.current?.getVideoTracks()[0];
      if (currentAudio) void audioTransceiver.sender.replaceTrack(currentAudio);
      if (currentVideo) void videoTransceiver.sender.replaceTrack(currentVideo);
    }
    const scheduleIceRecovery = (peer: RTCPeerConnection) => {
      if (disconnectedTimerRef.current !== null) return; // recovery already running
      const step = () => {
        disconnectedTimerRef.current = null;
        if (pcRef.current !== peer) return;
        const state = peer.connectionState;
        if (state === 'connected' || state === 'closed') {
          iceRestartAttemptsRef.current = 0;
          return;
        }
        if (channelRef.current?.readyState !== 'open' || iceRestartAttemptsRef.current >= MAX_ICE_RESTARTS) {
          setStatus('связь потеряна');
          setError('Не удалось восстановить прямое соединение. Создайте новое приглашение.');
          return;
        }
        iceRestartAttemptsRef.current += 1;
        setStatus(`восстанавливаем связь… (попытка ${iceRestartAttemptsRef.current})`);
        attemptIceRestart();
        disconnectedTimerRef.current = window.setTimeout(step, Math.min(2500 * iceRestartAttemptsRef.current, 8_000));
      };
      // Give ICE a moment to self-heal before forcing a restart.
      disconnectedTimerRef.current = window.setTimeout(step, 1_500);
    };

    pc.onconnectionstatechange = () => {
      if (pcRef.current !== pc) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        iceRestartAttemptsRef.current = 0;
        if (disconnectedTimerRef.current !== null) window.clearTimeout(disconnectedTimerRef.current);
        disconnectedTimerRef.current = null;
        setError('');
        setStatus('прямое соединение');
        return;
      }
      if (state === 'disconnected' || state === 'failed') {
        setStatus(state === 'failed' ? 'связь прервалась, восстанавливаем…' : 'восстанавливаем связь…');
        scheduleIceRecovery(pc);
        return;
      }
      const labels: Record<string, string> = {
        new: 'ожидание', connecting: 'соединяемся…', closed: 'соединение закрыто',
      };
      setStatus(labels[state] || state);
    };
    pc.ondatachannel = (event) => bindChannel(event.channel);
    pc.ontrack = (event) => {
      if (!remoteStreamRef.current.getTracks().some((track) => track.id === event.track.id)) {
        remoteStreamRef.current.addTrack(event.track);
      }
      // Only the first audio m-line is the friend's microphone. Screen-share
      // audio arrives on a later transceiver and must be audible but must NOT
      // drive presence, otherwise stopping a share flips "друг в звонке" off.
      const audioTransceivers = pc.getTransceivers().filter((item) => item.receiver.track.kind === 'audio');
      const isPrimaryAudio = event.track.kind === 'audio'
        && audioTransceivers[0]?.receiver.track.id === event.track.id;
      if (isPrimaryAudio) remotePrimaryAudioRef.current = event.track;
      const showTrack = () => {
        if (isPrimaryAudio) setRemoteAudioOn(true);
        if (event.track.kind === 'video') setRemoteVideoOn(true);
        window.requestAnimationFrame(attachCallStreams);
      };
      const hideTrack = () => {
        if (isPrimaryAudio) setRemoteAudioOn(false);
        if (event.track.kind === 'video') setRemoteVideoOn(false);
      };
      event.track.onunmute = showTrack;
      event.track.onmute = hideTrack;
      event.track.onended = hideTrack;
      if (!event.track.muted) showTrack();
      window.requestAnimationFrame(attachCallStreams);
    };
    return pc;
  }, [attachCallStreams, bindChannel, attemptIceRestart]);

  const renegotiateMedia = async () => {
    const channel = channelRef.current;
    if (channel?.readyState !== 'open') return;
    try {
      if (politePeerRef.current) {
        channel.send(JSON.stringify({ type: 'rtc-renegotiate-request' }));
        return;
      }
      await sendCurrentMediaOffer();
    } catch (renegotiateError) {
      console.warn('[RIFT] renegotiate failed', renegotiateError);
    }
  };

  const sendCallState = (audio: boolean, video: boolean) => {
    if (channelRef.current?.readyState === 'open') {
      channelRef.current.send(JSON.stringify({ type: 'call-state', audio, video }));
    }
  };

  const createOffer = async () => {
    setError('');
    setStatus('создаём приглашение…');
    try {
      const pc = createPeer();
      bindChannel(pc.createDataChannel('rift-chat', { ordered: true }));
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIce(pc);
      setGeneratedSignal(JSON.stringify(pc.localDescription));
      setSignalMode('host-offer');
      setStatus('ждём код ответа');
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      setError(/constructor|WebRTC|RTCPeerConnection/i.test(message)
        ? WEBRTC_UNAVAILABLE_MESSAGE
        : message || 'Не удалось создать приглашение');
    }
  };

  const createLinkInvite = async () => {
    setError('');
    setShareLink('');
    setStatus('создаём короткую ссылку…');
    try {
      pairingStopRef.current?.();
      const pc = createPeer();
      bindChannel(pc.createDataChannel('rift-chat', { ordered: true }));
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIce(pc);
      const session = await createPairingLink(JSON.stringify(pc.localDescription), (answerText) => {
        void pc.setRemoteDescription(JSON.parse(answerText) as RTCSessionDescriptionInit).then(() => {
          setStatus('соединяемся…');
          setSignalMode('host-answer');
          setSignalOpen(false);
        }).catch(() => setError('Друг ответил, но соединение не удалось. Создай новую ссылку.'));
      });
      pairingStopRef.current = session.stop;
      setShareLink(session.link);
      setSignalMode('host-offer');
      setStatus('ждём друга по ссылке');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      setError(/constructor|WebRTC|RTCPeerConnection/i.test(message) ? WEBRTC_UNAVAILABLE_MESSAGE : message || 'Не удалось создать ссылку');
      setStatus('не подключено');
    }
  };

  const joinFromLink = async (link = linkDraft) => {
    setError('');
    setStatus('ищем приглашение…');
    try {
      await answerPairingLink(link, async (offerText) => {
        const pc = createPeer(true);
        await pc.setRemoteDescription(JSON.parse(offerText) as RTCSessionDescriptionInit);
        await pc.setLocalDescription(await pc.createAnswer());
        await waitForIce(pc);
        return JSON.stringify(pc.localDescription);
      });
      setSignalOpen(false);
      setStatus('соединяемся…');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      setError(/constructor|WebRTC|RTCPeerConnection/i.test(message) ? WEBRTC_UNAVAILABLE_MESSAGE : message || 'Не удалось открыть приглашение');
      setStatus('не подключено');
    }
  };

  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 2500);
    } catch {
      setError('Не удалось скопировать ссылку. Выдели её вручную.');
    }
  };

  const acceptOffer = async (offerText = signalText) => {
    setError('');
    try {
      const offer = JSON.parse(offerText) as RTCSessionDescriptionInit;
      const pc = createPeer(true);
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await waitForIce(pc);
      setGeneratedSignal(JSON.stringify(pc.localDescription));
      setSignalMode('guest-offer');
      setStatus('отправь код ответа другу');
    } catch (error) {
      setError(error instanceof Error && /constructor|WebRTC|RTCPeerConnection/i.test(error.message)
        ? WEBRTC_UNAVAILABLE_MESSAGE
        : 'Код приглашения повреждён или вставлен не полностью');
    }
  };

  const acceptAnswer = async (answerText = signalText) => {
    setError('');
    try {
      const answer = JSON.parse(answerText) as RTCSessionDescriptionInit;
      if (!pcRef.current) throw new Error();
      await pcRef.current.setRemoteDescription(answer);
      setSignalMode('host-answer');
      setStatus('соединяемся…');
    } catch {
      setError('Код ответа повреждён или приглашение уже закрыто');
    }
  };

  const handleQrResult = useCallback((value: string) => {
    try {
      const signal = unpackSignal(value);
      const mode = scannerMode;
      setScannerMode(null);
      if (mode === 'offer') void acceptOffer(signal);
      else if (mode === 'answer') void acceptAnswer(signal);
    } catch {
      setError('Это не QR-код подключения RIFT.');
    }
  }, [scannerMode]);

  // If the active mic device dies mid-call (USB headset unplugged), fall back
  // to the system default instead of leaving the call silently broken.
  const armMicRecovery = (track: MediaStreamTrack) => {
    track.onended = () => {
      if (rawMicTrackRef.current !== track) return;
      setError('Микрофон отключился — переключаюсь на устройство по умолчанию…');
      void changeInputDevice('');
    };
  };

  const enableMedia = async (kind: 'mic' | 'camera') => {
    // Single in-flight start: a double-click must not spawn two capture
    // pipelines fighting over the same transceiver.
    if (mediaBusyRef.current) return;
    mediaBusyRef.current = true;
    setError('');
    try {
      const stream = localStreamRef.current || new MediaStream();
      const media = await navigator.mediaDevices.getUserMedia({
        audio: kind === 'mic' && !stream.getAudioTracks().length ? {
          autoGainControl: autoGain,
          channelCount: 1,
          echoCancellation,
          noiseSuppression: !noiseSuppressionOn,
          sampleRate: 48000,
          ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
        } : false,
        video: kind === 'camera' && !stream.getVideoTracks().length,
      });
      for (const capturedTrack of media.getTracks()) {
        let track = capturedTrack;
        if (capturedTrack.kind === 'audio') {
          rawMicTrackRef.current = capturedTrack;
          armMicRecovery(capturedTrack);
          try {
            const pipeline = await createMicPipeline(capturedTrack, {
              rnnoise: noiseSuppressionOn,
              gain: micGain,
              rnnoiseTimeoutMs: RNNOISE_START_TIMEOUT_MS,
            });
            micPipelineRef.current = pipeline;
            track = pipeline.track;
            if (noiseSuppressionOn && !pipeline.rnnoiseActive()) {
              await capturedTrack.applyConstraints({ noiseSuppression: true }).catch(() => undefined);
              setNoiseSuppressionOn(false);
            }
          } catch (pipelineError) {
            console.warn('[RIFT] mic pipeline unavailable, sending raw mic', pipelineError);
            await capturedTrack.applyConstraints({ noiseSuppression: true }).catch(() => undefined);
          }
        }
        stream.addTrack(track);
        const transceiver = pcRef.current?.getTransceivers()
          .find((item) => item.receiver.track.kind === track.kind);
        if (transceiver) {
          transceiver.direction = 'sendrecv';
          await transceiver.sender.replaceTrack(track);
        }
      }
      localStreamRef.current = stream;
      if (stream.getAudioTracks().length) setMicOn(true);
      setCameraOn(stream.getVideoTracks().some((track) => track.enabled));
      setCallOpen(true);
      window.requestAnimationFrame(attachCallStreams);
      sendCallState(
        stream.getAudioTracks().length > 0,
        stream.getVideoTracks().some((track) => track.enabled) || sharing,
      );
      await renegotiateMedia();
    } catch (mediaError) {
      const reason = mediaError instanceof DOMException && mediaError.name === 'NotAllowedError'
        ? 'Разреши RIFT доступ к микрофону и камере в настройках Windows'
        : 'Не удалось включить камеру или микрофон — проверь, что устройство не занято';
      setError(reason);
    } finally {
      mediaBusyRef.current = false;
    }
  };

  const startCall = async () => {
    setCallOpen(true);
    setCallMinimized(false);
    window.requestAnimationFrame(attachCallStreams);
    const audioTrack = localStreamRef.current?.getAudioTracks()[0];
    if (!audioTrack) {
      await enableMedia('mic');
      return;
    }
    setMicOn(true);
    sendCallState(true, cameraOn || sharing);
  };

  const toggleMic = async () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return enableMedia('mic');
    const next = !micOn;
    setMicOn(next);
    sendCallState(next, cameraOn || sharing);
  };

  // Keep the send-side audio track gated from derived state: push-to-talk
  // transmits while the key is held; voice-activation transmits while local
  // voice is detected (localSpeaking, measured on the always-live raw mic).
  useEffect(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = micOn && (pttEnabled ? pttActive : localSpeaking);
  }, [micOn, pttEnabled, pttActive, localSpeaking, callOpen]);

  const changeMicGain = (value: number) => {
    setMicGain(value);
    micPipelineRef.current?.setGain(value);
  };

  const changeEchoCancellation = (value: boolean) => {
    setEchoCancellation(value);
    void rawMicTrackRef.current?.applyConstraints({ echoCancellation: value }).catch(() => undefined);
  };

  const changeAutoGain = (value: boolean) => {
    setAutoGain(value);
    void rawMicTrackRef.current?.applyConstraints({ autoGainControl: value }).catch(() => undefined);
  };

  const closeAudioModal = () => {
    setAudioModalOpen(false);
    setMicTestOn(false);
  };

  const toggleNoiseSuppression = async () => {
    const pipeline = micPipelineRef.current;
    const rawTrack = rawMicTrackRef.current;
    const next = !noiseSuppressionOn;
    if (!pipeline) {
      setNoiseSuppressionOn(next);
      return;
    }
    try {
      if (next) {
        await rawTrack?.applyConstraints({ noiseSuppression: false }).catch(() => undefined);
        await pipeline.setRnnoise(true);
        if (!pipeline.rnnoiseActive()) {
          await rawTrack?.applyConstraints({ noiseSuppression: true }).catch(() => undefined);
          setNoiseSuppressionOn(false);
          setError('RNNoise недоступен — оставил браузерное шумоподавление');
          return;
        }
      } else {
        await pipeline.setRnnoise(false);
        await rawTrack?.applyConstraints({ noiseSuppression: true }).catch(() => undefined);
      }
      setNoiseSuppressionOn(next);
    } catch (rnnoiseError) {
      console.error('[RIFT] failed to switch RNNoise', rnnoiseError);
      setError('Не удалось переключить RNNoise — оставил текущее аудио без изменений');
    }
  };

  const refreshAudioDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioInputs(devices.filter((device) => device.kind === 'audioinput'));
      setAudioOutputs(devices.filter((device) => device.kind === 'audiooutput'));
    } catch {
      // Enumeration can fail before any permission is granted; ignore.
    }
  }, []);

  useEffect(() => {
    void refreshAudioDevices();
    const md = navigator.mediaDevices;
    md?.addEventListener?.('devicechange', refreshAudioDevices);
    return () => md?.removeEventListener?.('devicechange', refreshAudioDevices);
  }, [refreshAudioDevices]);

  // Route remote audio to the chosen output device (speakers/headset).
  useEffect(() => {
    const element = remoteAudioRef.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (element?.setSinkId && outputDeviceId) {
      void element.setSinkId(outputDeviceId).catch(() => undefined);
    }
  }, [outputDeviceId, callOpen]);

  // Per-participant volume + deafen: scale the remote audio element output.
  useEffect(() => {
    const element = remoteAudioRef.current;
    if (element) element.volume = deafened ? 0 : Math.min(1, remoteVolume);
  }, [remoteVolume, deafened, callOpen, remoteAudioOn]);

  // Voice-activity detection on the always-live raw mic (before the send gate,
  // to avoid a mute->silence->stay-muted deadlock). Drives both the transmit
  // gate in voice mode and the "you're talking" ring, plus the live level meter.
  useEffect(() => {
    if (!callOpen) {
      setLocalSpeaking(false);
      return;
    }
    const raw = rawMicTrackRef.current;
    if (!raw) {
      setLocalSpeaking(false);
      return;
    }
    // Probe a CLONE: if the raw track is also the sending track (pipeline
    // fallback), the VAD gate disabling it would silence the detector too and
    // the mic could never re-open. A clone keeps delivering audio regardless.
    const probe = raw.clone();
    const stop = createSpeakingMonitor(new MediaStream([probe]), setLocalSpeaking, {
      threshold: (vadAuto ? 12 : vadThreshold) * 0.45,
      onLevel: setInputLevel,
    });
    return () => {
      stop();
      probe.stop();
      setLocalSpeaking(false);
      setInputLevel(0);
    };
  }, [callOpen, micOn, inputDeviceId, noiseSuppressionOn, vadAuto, vadThreshold]);

  // Standalone mic test (level meter) for the settings panel when not in a call.
  useEffect(() => {
    if (!micTestOn || (callOpen && rawMicTrackRef.current)) return;
    let stopped = false;
    let stopMonitor = () => undefined as void;
    let testStream: MediaStream | null = null;
    navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: autoGain,
        echoCancellation,
        noiseSuppression: false,
        ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
      },
    }).then((stream) => {
      if (stopped) { stream.getTracks().forEach((track) => track.stop()); return; }
      testStream = stream;
      stopMonitor = createSpeakingMonitor(stream, () => undefined, { threshold: 999, onLevel: setInputLevel });
    }).catch(() => setError('Не удалось открыть микрофон для проверки'));
    return () => {
      stopped = true;
      stopMonitor();
      testStream?.getTracks().forEach((track) => track.stop());
      setInputLevel(0);
    };
  }, [micTestOn, callOpen, inputDeviceId, echoCancellation, autoGain]);

  // Active-speaker detection for the remote peer (drives the "friend talking"
  // ring). Watches only the friend's MICROPHONE track — game/screen audio in
  // the mixed remote stream must not light the ring permanently.
  useEffect(() => {
    if (!callOpen || !remoteAudioOn) {
      setRemoteSpeaking(false);
      return;
    }
    const primary = remotePrimaryAudioRef.current;
    const stream = primary ? new MediaStream([primary]) : remoteStreamRef.current;
    const stop = createSpeakingMonitor(stream, setRemoteSpeaking);
    return () => {
      stop();
      setRemoteSpeaking(false);
    };
  }, [callOpen, remoteAudioOn]);

  // Push-to-talk: while enabled, Space (outside text fields) unmutes the mic.
  useEffect(() => {
    if (!callOpen || !pttEnabled) {
      setPttActive(false);
      return;
    }
    const isTyping = () => {
      const element = document.activeElement as HTMLElement | null;
      return Boolean(element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable));
    };
    const onDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || isTyping()) return;
      event.preventDefault();
      if (!event.repeat) setPttActive(true);
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      setPttActive(false);
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [callOpen, pttEnabled]);

  const changeInputDevice = async (deviceId: string) => {
    setInputDeviceId(deviceId);
    const stream = localStreamRef.current;
    if (!stream?.getAudioTracks().length) return; // applied next time the mic starts
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: autoGain,
          channelCount: 1,
          echoCancellation,
          noiseSuppression: !noiseSuppressionOn,
          sampleRate: 48000,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
        video: false,
      });
      const newRaw = media.getAudioTracks()[0];
      micPipelineRef.current?.stop();
      micPipelineRef.current = null;
      rawMicTrackRef.current?.stop();
      rawMicTrackRef.current = newRaw;
      armMicRecovery(newRaw);
      const pipeline = await createMicPipeline(newRaw, {
        rnnoise: noiseSuppressionOn,
        gain: micGain,
        rnnoiseTimeoutMs: RNNOISE_START_TIMEOUT_MS,
      });
      micPipelineRef.current = pipeline;
      const nextTrack = pipeline.track;
      nextTrack.enabled = pttEnabled ? (micOn && pttActive) : micOn;
      const oldTrack = stream.getAudioTracks()[0];
      if (oldTrack) stream.removeTrack(oldTrack);
      stream.addTrack(nextTrack);
      const sender = pcRef.current?.getTransceivers()
        .find((item) => item.receiver.track.kind === 'audio')?.sender;
      await sender?.replaceTrack(nextTrack);
      if (noiseSuppressionOn && !pipeline.rnnoiseActive()) {
        await newRaw.applyConstraints({ noiseSuppression: true }).catch(() => undefined);
        setNoiseSuppressionOn(false);
      }
    } catch {
      setError('Не удалось переключить микрофон — устройство занято или недоступно');
    }
  };

  const toggleCamera = async () => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) return enableMedia('camera');
    track.enabled = !track.enabled;
    setCameraOn(track.enabled);
    sendCallState(micOn, track.enabled || sharing);
  };

  const videoTransceiver = () =>
    pcRef.current?.getTransceivers().find((item) => item.receiver.track.kind === 'video');

  // The local "talking" ring reflects what the friend actually hears:
  // muted or un-held PTT means no glow even while the raw mic picks up voice.
  const localTalking = localSpeaking && micOn && (!pttEnabled || pttActive);

  // Discord-style fullscreen: double-click a tile (or its button) to expand.
  const toggleTileFullscreen = (element: HTMLElement | null) => {
    if (!element) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void element.requestFullscreen().catch(() => undefined);
  };

  const applyVideoBitrate = async (quality: ScreenQuality) => {
    const sender = videoTransceiver()?.sender;
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = bitrateForQuality(quality);
    params.encodings[0].maxFramerate = quality.fps;
    await sender.setParameters(params).catch(() => undefined);
  };

  const applyCodecPreference = () => {
    if (screenCodec === 'auto') return;
    const transceiver = videoTransceiver();
    const caps = RTCRtpSender.getCapabilities?.('video');
    if (!transceiver || !transceiver.setCodecPreferences || !caps) return;
    const needle = screenCodec.toLowerCase();
    const preferred = caps.codecs.filter((codec) => codec.mimeType.toLowerCase().includes(needle));
    const rest = caps.codecs.filter((codec) => !codec.mimeType.toLowerCase().includes(needle));
    if (preferred.length) {
      try { transceiver.setCodecPreferences([...preferred, ...rest]); } catch { /* unsupported */ }
    }
  };

  const stopScreenShare = async () => {
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    screenSourceIdRef.current = null;
    const cameraTrack = localStreamRef.current?.getVideoTracks()[0] || null;
    await videoTransceiver()?.sender.replaceTrack(cameraTrack);
    const audioTransceiver = screenAudioTransceiverRef.current;
    if (audioTransceiver) {
      // Keep the transceiver for reuse; just silence its m-line.
      await audioTransceiver.sender.replaceTrack(null).catch(() => undefined);
      try { audioTransceiver.direction = 'inactive'; } catch { /* closed */ }
      await renegotiateMedia();
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
    setSharing(false);
    sendCallState(micOn, cameraOn);
  };

  const startScreenShare = async (sourceId: string) => {
    try {
      const stream = await captureScreenSource(sourceId, screenQuality);
      screenStreamRef.current = stream;
      screenSourceIdRef.current = sourceId;
      const videoTrack = stream.getVideoTracks()[0];
      const transceiver = videoTransceiver();
      if (transceiver) {
        transceiver.direction = 'sendrecv';
        applyCodecPreference();
        await transceiver.sender.replaceTrack(videoTrack);
      } else if (pcRef.current) {
        pcRef.current.addTrack(videoTrack, stream);
      }
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && pcRef.current) {
        // A dedicated transceiver so screen audio can never hijack the mic
        // m-line; reused across share sessions to avoid piling up m-lines.
        if (screenAudioTransceiverRef.current) {
          screenAudioTransceiverRef.current.direction = 'sendonly';
          await screenAudioTransceiverRef.current.sender.replaceTrack(audioTrack);
        } else {
          screenAudioTransceiverRef.current = pcRef.current.addTransceiver(audioTrack, {
            direction: 'sendonly',
            streams: [stream],
          });
        }
      }
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      setSharing(true);
      setCallOpen(true);
      await renegotiateMedia();
      await applyVideoBitrate(screenQuality);
      sendCallState(micOn, true);
      videoTrack.onended = () => void stopScreenShare();
    } catch {
      setError('Не удалось начать демонстрацию экрана');
    }
  };

  const openScreenPicker = async () => {
    const desktop = window.riftDesktop;
    if (!desktop) {
      // Browser fallback: no in-app picker, use the OS getDisplayMedia dialog.
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: screenQuality.audio });
        screenStreamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        const transceiver = videoTransceiver();
        if (transceiver) { transceiver.direction = 'sendrecv'; await transceiver.sender.replaceTrack(track); }
        else if (pcRef.current) pcRef.current.addTrack(track, stream);
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        setSharing(true);
        setCallOpen(true);
        await renegotiateMedia();
        sendCallState(micOn, true);
        track.onended = () => setSharing(false);
      } catch {
        setError('Демонстрация экрана отменена');
      }
      return;
    }
    setScreenLoading(true);
    setScreenPickerOpen(true);
    try {
      const sources = await desktop.getDesktopSources({ thumbnailSize: { width: 320, height: 180 } });
      setScreenSources(sources);
    } catch {
      setError('Не удалось получить список окон для демонстрации');
    }
    setScreenLoading(false);
  };

  const pickScreenSource = async (sourceId: string) => {
    setScreenPickerOpen(false);
    await startScreenShare(sourceId);
  };

  const changeScreenQuality = async (next: ScreenQuality) => {
    setScreenQuality(next);
    if (!sharing || !screenSourceIdRef.current || !window.riftDesktop) return;
    // Re-capture at the new resolution/fps and hot-swap the tracks (no renegotiation).
    try {
      const stream = await captureScreenSource(screenSourceIdRef.current, next);
      const previous = screenStreamRef.current;
      screenStreamRef.current = stream;
      const videoTrack = stream.getVideoTracks()[0];
      await videoTransceiver()?.sender.replaceTrack(videoTrack);
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && screenAudioTransceiverRef.current) {
        await screenAudioTransceiverRef.current.sender.replaceTrack(audioTrack).catch(() => undefined);
      }
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      await applyVideoBitrate(next);
      previous?.getTracks().forEach((track) => track.stop());
      videoTrack.onended = () => void stopScreenShare();
    } catch {
      setError('Не удалось сменить качество демонстрации');
    }
  };

  const toggleScreen = async () => {
    if (sharing) { await stopScreenShare(); return; }
    await openScreenPicker();
  };

  const hangUp = () => {
    sendCallState(false, false);
    pcRef.current?.getSenders().forEach((sender) => {
      if (sender.track?.kind === 'audio' || sender.track?.kind === 'video') void sender.replaceTrack(null);
    });
    micPipelineRef.current?.stop();
    micPipelineRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    rawMicTrackRef.current?.stop();
    rawMicTrackRef.current = null;
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    screenStreamRef.current = null;
    setMicOn(false);
    setCameraOn(false);
    setSharing(false);
    setCallOpen(false);
    setCallMinimized(false);
  };

  const sendPacket = (packet: Record<string, unknown>) => {
    if (channelRef.current?.readyState === 'open') {
      channelRef.current.send(JSON.stringify(packet));
      return true;
    }
    return false;
  };

  const handleDraftChange = (value: string) => {
    setDraft(value);
    // Discord-style ephemeral typing signal, throttled per channel.
    const now = Date.now();
    if (value.trim() && now - typingSentAtRef.current > TYPING_THROTTLE_MS) {
      typingSentAtRef.current = now;
      sendPacket({ type: 'typing', channelId: activeChannel.id, author: profileName });
    }
  };

  const sendMessage = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;

    if (editingId) {
      setMessagesByChannel((all) => ({
        ...all,
        [activeChannel.id]: (all[activeChannel.id] || []).map((message) =>
          message.id === editingId ? { ...message, text, edited: true } : message),
      }));
      sendPacket({ type: 'message-edit', id: editingId, channelId: activeChannel.id, text });
      setEditingId(null);
      setDraft('');
      return;
    }

    const message: Message = {
      id: crypto.randomUUID(), author: profileName, text, own: true, status: 'sent',
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      ...(replyTo ? { replyTo } : {}),
    };
    setMessagesByChannel((all) => ({
      ...all,
      [activeChannel.id]: [...(all[activeChannel.id] || []), message],
    }));
    sendPacket({
      type: 'message',
      id: message.id,
      text,
      author: profileName,
      channelId: activeChannel.id,
      channelName: activeChannel.name,
      ...(replyTo ? { replyTo } : {}),
    });
    setReplyTo(null);
    setDraft('');
  };

  const startReply = (message: Message) => {
    setEditingId(null);
    setReplyTo({ id: message.id, author: message.author, text: message.text.slice(0, 120) });
  };

  const startEdit = (message: Message) => {
    setReplyTo(null);
    setEditingId(message.id);
    setDraft(message.text);
  };

  const cancelComposerExtras = () => {
    setReplyTo(null);
    if (editingId) {
      setEditingId(null);
      setDraft('');
    }
  };

  const deleteMessage = (message: Message) => {
    setMessagesByChannel((all) => ({
      ...all,
      [activeChannel.id]: (all[activeChannel.id] || []).filter((item) => item.id !== message.id),
    }));
    sendPacket({ type: 'message-delete', id: message.id, channelId: activeChannel.id });
  };

  const toggleReaction = (message: Message, emoji: string) => {
    const names = new Set(message.reactions?.[emoji] || []);
    const add = !names.has(profileName);
    if (add) names.add(profileName);
    else names.delete(profileName);
    setMessagesByChannel((all) => ({
      ...all,
      [activeChannel.id]: (all[activeChannel.id] || []).map((item) => {
        if (item.id !== message.id) return item;
        const reactions = { ...(item.reactions || {}) };
        if (names.size) reactions[emoji] = [...names];
        else delete reactions[emoji];
        return { ...item, reactions };
      }),
    }));
    sendPacket({ type: 'reaction', id: message.id, channelId: activeChannel.id, emoji, add, author: profileName });
  };

  // Appearance: accent hue drives every --acid usage via the CSS variable.
  useEffect(() => {
    document.documentElement.style.setProperty('--accent-h', String(accentHue));
  }, [accentHue]);

  // Flush read receipts when the channel becomes visible (switch or refocus).
  useEffect(() => {
    const flushReads = () => {
      const pending = pendingReadRef.current.get(activeChannelId);
      if (!pending?.size || !document.hasFocus()) return;
      if (sendPacket({ type: 'msg-ack', ids: [...pending], channelId: activeChannelId, status: 'read' })) {
        pendingReadRef.current.delete(activeChannelId);
      }
    };
    flushReads();
    window.addEventListener('focus', flushReads);
    return () => window.removeEventListener('focus', flushReads);
  }, [activeChannelId]);

  const waitForChannelBuffer = async (channel: RTCDataChannel) => {
    while (channel.bufferedAmount > 512 * 1024) {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    }
  };

  const sendFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      setError('Пока можно отправлять файлы размером до 8 МБ');
      return;
    }
    const channel = channelRef.current;
    if (!channel || channel.readyState !== 'open') {
      setError('Сначала подключи друга, потом отправляй файл');
      return;
    }

    const attachment: Attachment = {
      id: crypto.randomUUID(),
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
    };
    const message: Message = {
      id: crypto.randomUUID(),
      author: profileName,
      text: '',
      own: true,
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      attachment,
    };

    try {
      setTransferLabel(`отправляем ${file.name}…`);
      await saveAttachment(attachment.id, file);
      setMessagesByChannel((all) => ({
        ...all,
        [activeChannel.id]: [...(all[activeChannel.id] || []), message],
      }));
      const transferId = crypto.randomUUID();
      channel.send(JSON.stringify({
        type: 'file-meta', transferId, attachment, author: profileName,
        channelId: activeChannel.id, channelName: activeChannel.name,
      }));
      const bytes = new Uint8Array(await file.arrayBuffer());
      for (let offset = 0; offset < bytes.length; offset += FILE_CHUNK_SIZE) {
        await waitForChannelBuffer(channel);
        channel.send(JSON.stringify({
          type: 'file-chunk',
          transferId,
          chunk: bytesToBase64(bytes.subarray(offset, offset + FILE_CHUNK_SIZE)),
        }));
        setTransferLabel(`отправляем ${file.name} · ${Math.min(100, Math.round((offset + FILE_CHUNK_SIZE) / bytes.length * 100))}%`);
      }
      channel.send(JSON.stringify({ type: 'file-end', transferId }));
      setTransferLabel('');
    } catch {
      setTransferLabel('');
      setError('Передача файла сорвалась — попробуй ещё раз');
    }
  };

  const openChannel = (channelId: string) => {
    setActiveChannelId(channelId);
    setUnread((items) => ({ ...items, [channelId]: 0 }));
  };

  const createChannel = (event: FormEvent) => {
    event.preventDefault();
    const name = newChannelName.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 28);
    if (!name) return;
    const id = `${name}-${crypto.randomUUID().slice(0, 6)}`;
    setChannels((items) => [...items, { id, name }]);
    setMessagesByChannel((all) => ({ ...all, [id]: [] }));
    setActiveChannelId(id);
    setNewChannelName('');
    setChannelModalOpen(false);
  };

  const saveProfile = (event: FormEvent) => {
    event.preventDefault();
    const name = profileDraft.trim().slice(0, 24);
    if (!name) return;
    setProfileName(name);
    setProfileModalOpen(false);
  };

  const disconnect = () => {
    hangUp();
    channelRef.current?.close();
    pcRef.current?.close();
    channelRef.current = null;
    pcRef.current = null;
    remoteStreamRef.current.getTracks().forEach((track) => {
      remoteStreamRef.current.removeTrack(track);
    });
    setRemoteAudioOn(false);
    setRemoteVideoOn(false);
    setStatus('не подключено');
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeChannelId]);

  useEffect(() => {
    if (callOpen) attachCallStreams();
  }, [attachCallStreams, callMinimized, callOpen]);

  useEffect(() => {
    const desktop = window.riftDesktop;
    if (!desktop) return undefined;
    const openLink = (url: string) => {
      if (!url.startsWith('rift://join/') || handledLinksRef.current.has(url)) return;
      handledLinksRef.current.add(url);
      setSignalOpen(true);
      setLinkDraft(url);
      void joinFromLink(url);
    };
    return desktop.onDeepLink(openLink);
  }, []);

  useEffect(() => () => {
    micPipelineRef.current?.stop();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    rawMicTrackRef.current?.stop();
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    pairingStopRef.current?.();
    if (disconnectedTimerRef.current !== null) window.clearTimeout(disconnectedTimerRef.current);
    pcRef.current?.close();
  }, []);

  return (
    <main className="app-shell">
      {(updater.state.phase === 'downloading' || updater.state.phase === 'installing' || updater.state.phase === 'error') && (
        <div className="mandatory-update" role="alertdialog" aria-modal="true">
          <div className="update-card">
            <div className="update-mark"><Download /></div>
            {updater.state.phase === 'error' ? <>
              <div className="modal-kicker">ОБНОВЛЕНИЕ НЕ УСТАНОВЛЕНО</div>
              <h2>Нужна свежая версия RIFT</h2>
              <p>Старая версия заблокирована, чтобы разные клиенты не ломали соединение.</p>
              <code>{updater.state.message}</code>
              <button className="primary-action" onClick={() => void updater.retry()}>Повторить</button>
            </> : <>
              <div className="modal-kicker">ОБЯЗАТЕЛЬНОЕ ОБНОВЛЕНИЕ</div>
              <h2>{updater.state.phase === 'installing' ? 'Устанавливаем…' : `Скачиваем RIFT ${updater.state.version}`}</h2>
              <p>Приложение перезапустится автоматически. История и настройки останутся на месте.</p>
              <div className="update-progress"><span style={{ width: `${updater.state.phase === 'downloading' ? updater.state.progress ?? 12 : 100}%` }} /></div>
              <small>{updater.state.phase === 'downloading' && updater.state.progress !== null ? `${updater.state.progress}%` : 'подожди немного'}</small>
            </>}
          </div>
        </div>
      )}
      <aside className="server-rail">
        <button className="rift-mark" aria-label="RIFT"><span>R</span></button>
        <div className="rail-line" />
        {servers.map((server) => (
          <button key={server.label} className={`server-button ${server.active ? 'active' : ''}`}>{server.label}</button>
        ))}
        <button className="server-button add"><Plus size={20} /></button>
      </aside>

      <aside className="channel-panel">
        <header className="workspace-title">
          <div><span className="eyebrow">ПРОСТРАНСТВО</span><strong>RIFT / ZERO</strong></div>
          <button className="help-button" onClick={() => setOnboardingOpen(true)} title="Как подключить друга"><CircleHelp size={17} /></button>
        </header>
        <div className="channel-scroll">
          <section className="channel-group">
            <div className="group-label"><span>ТЕКСТ</span><button onClick={() => setChannelModalOpen(true)} title="Создать канал"><Plus size={14} /></button></div>
            {channels.map((channel) => (
              <button
                className={`channel ${activeChannel.id === channel.id ? 'active' : ''}`}
                key={channel.id}
                onClick={() => openChannel(channel.id)}
              >
                <Hash size={17} /> {channel.name}
                {unread[channel.id] > 0 && <span className="unread-count">{unread[channel.id]}</span>}
                {activeChannel.id === channel.id && <span className="live-dot" />}
              </button>
            ))}
          </section>
          <section className="channel-group voice-group">
            <div className="group-label"><span>ГОЛОС</span><Plus size={14} /></div>
            <button className="channel"><Volume2 size={17} /> радиорубка</button>
            <div className="voice-user"><div className="mini-avatar">{profileName.slice(0, 1).toUpperCase()}</div><span>{profileName}</span><Radio size={12} /></div>
            <button className="channel"><Volume2 size={17} /> тихий угол</button>
          </section>
        </div>
        <div className="connection-card">
          <div className={`signal-pulse ${status === 'прямое соединение' ? 'online' : ''}`}><Link2 size={15} /></div>
          <div><strong>{status}</strong><span>P2P · шифрование DTLS</span></div>
          {pcRef.current && <button onClick={disconnect} title="Отключиться"><PhoneOff size={15} /></button>}
        </div>
        <footer className="user-bar">
          <div className="avatar">{profileName.slice(0, 1).toUpperCase()}<span /></div>
          <button className="user-copy" onClick={() => { setProfileDraft(profileName); setProfileModalOpen(true); }}><strong>{profileName}</strong><span>#локально</span></button>
          <button onClick={toggleMic}>{micOn ? <Mic size={17} /> : <MicOff size={17} />}</button>
          <button onClick={() => { void refreshAudioDevices(); setAudioModalOpen(true); }} title="Настройки звука"><Headphones size={17} /></button>
          <button onClick={() => { setProfileDraft(profileName); setProfileModalOpen(true); }}><Settings size={17} /></button>
        </footer>
      </aside>

      <section className="main-panel">
        <header className="room-header">
          <div className="room-name"><Hash size={20} /><strong>{activeChannel.name}</strong><span>Связь без центрального сервера</span></div>
          <div className="header-actions">
            <button onClick={() => callOpen ? setCallMinimized(false) : void startCall()} title={callOpen ? 'Показать звонок' : 'Войти в звонок'}><Video size={19} /></button>
            <button onClick={() => setSignalOpen(true)} className="invite-button"><Link2 size={16} /> Подключить друга</button>
            <button><Users size={19} /></button>
            <div className="search-box"><span>Поиск</span><Search size={15} /></div>
          </div>
        </header>

        {callOpen && <audio ref={remoteAudioRef} autoPlay />}

        {callOpen && callMinimized && (
          <section className="call-bar">
            <div><span className={remoteSpeaking ? 'voice-dot active' : 'voice-dot'} /><strong>Голосовой звонок</strong><small>{remoteSpeaking ? 'друг говорит' : (remoteAudioOn ? 'друг в звонке' : 'ожидаем друга')}</small></div>
            <div className="call-bar-controls">
              <button onClick={toggleMic} className={micOn ? 'enabled' : ''} title={micOn ? 'Выключить микрофон' : 'Включить микрофон'}>{micOn ? <Mic /> : <MicOff />}</button>
              <button onClick={() => setDeafened((value) => !value)} className={deafened ? 'danger' : ''} title={deafened ? 'Включить звук друга' : 'Заглушить друга'}>{deafened ? <VolumeX /> : <Volume2 />}</button>
              <button onClick={() => void toggleNoiseSuppression()} className={noiseSuppressionOn ? 'enabled accent' : ''} title={`RNNoise: ${noiseSuppressionOn ? 'включён' : 'выключен'}`}><Waves /></button>
              <button onClick={() => { void refreshAudioDevices(); setAudioModalOpen(true); }} title="Настройки звука"><Sliders /></button>
              <button onClick={() => setCallMinimized(false)} title="Развернуть звонок"><Maximize2 /></button>
              <button onClick={hangUp} className="danger" title="Выйти из звонка"><PhoneOff /></button>
            </div>
          </section>
        )}

        {callOpen && !callMinimized && (
          <section className="call-stage">
            <div className="video-grid">
              <div ref={remoteTileRef} className={remoteSpeaking && !remoteVideoOn ? 'video-tile remote speaking' : 'video-tile remote'} onDoubleClick={() => toggleTileFullscreen(remoteTileRef.current)}>
                <video ref={remoteVideoRef} autoPlay muted playsInline />
                {!remoteVideoOn && <div className="video-empty"><div className={remoteSpeaking ? 'orb speaking' : 'orb'}>?</div><span>{remoteAudioOn ? 'Друг в голосовом звонке' : 'Ожидаем друга в звонке'}</span></div>}
                <span className="video-label">{deafened ? <VolumeX size={12} /> : null}Собеседник</span>
                <button className="tile-fs" title="На весь экран (двойной клик)" onClick={() => toggleTileFullscreen(remoteTileRef.current)}><Maximize2 size={14} /></button>
              </div>
              <div ref={localTileRef} className={localTalking && !cameraOn && !sharing ? 'video-tile local speaking' : 'video-tile local'} onDoubleClick={() => toggleTileFullscreen(localTileRef.current)}>
                <video ref={localVideoRef} autoPlay muted playsInline />
                {!cameraOn && !sharing && <div className="video-empty"><div className={localTalking ? 'orb own speaking' : 'orb own'}>Я</div></div>}
                <span className="video-label">{(pttEnabled ? !(micOn && pttActive) : !micOn) ? <MicOff size={12} /> : null}{profileName}{sharing && ' · экран'}</span>
                <button className="tile-fs" title="На весь экран (двойной клик)" onClick={() => toggleTileFullscreen(localTileRef.current)}><Maximize2 size={14} /></button>
              </div>
            </div>
            {pttEnabled && (
              <div className={pttActive ? 'ptt-hint talking' : 'ptt-hint'}>
                <Radio size={14} /> {pttActive ? 'Говоришь…' : 'Push-to-talk: держи пробел, чтобы говорить'}
              </div>
            )}
            <div className="call-controls">
              <button onClick={toggleMic} className={(pttEnabled ? (micOn && pttActive) : micOn) ? 'enabled' : ''} title={pttEnabled ? 'Push-to-talk активен (пробел)' : (micOn ? 'Выключить микрофон' : 'Включить микрофон')}>{(pttEnabled ? (micOn && pttActive) : micOn) ? <Mic /> : <MicOff />}</button>
              <button onClick={() => void toggleNoiseSuppression()} className={noiseSuppressionOn ? 'enabled accent' : ''} title={`Шумоподавление RNNoise: ${noiseSuppressionOn ? 'включено' : 'выключено'}`}><Waves /></button>
              <button onClick={() => setDeafened((value) => !value)} className={deafened ? 'danger' : ''} title={deafened ? 'Включить звук друга' : 'Заглушить друга'}>{deafened ? <VolumeX /> : <Volume2 />}</button>
              <button onClick={toggleCamera} className={cameraOn ? 'enabled' : ''}>{cameraOn ? <Camera /> : <CameraOff />}</button>
              <button onClick={toggleScreen} className={sharing ? 'enabled accent' : ''}><MonitorUp /></button>
              <button onClick={() => { void refreshAudioDevices(); setAudioModalOpen(true); }} title="Настройки звука"><Sliders /></button>
              <button onClick={() => setCallMinimized(true)} title="Свернуть звонок"><Minimize2 /></button>
              <button onClick={hangUp} className="danger"><PhoneOff /></button>
            </div>
          </section>
        )}

        <div className={bubbleStyle ? 'messages bubbles' : 'messages'}>
          <div className="channel-intro">
            <div className="hash-block"><Hash size={30} /></div>
            <h1>{activeChannel.name}</h1>
            <p>{messages.length ? 'Локальная история этого канала сохранена на устройстве.' : 'Пока пусто. Начни разговор — история сохранится на этом устройстве.'}</p>
            <div className="privacy-chip"><Sparkles size={14} /> P2P-FIRST</div>
          </div>
          {messages.map((message) => (
            <article className={`message ${message.own ? 'own' : ''}`} key={message.id}>
              <div className={`message-avatar ${message.author === 'RIFT' ? 'system' : ''}`}>{message.author.slice(0, 1)}</div>
              <div className="message-body">
                {message.replyTo && (
                  <div className="reply-ref"><CornerUpLeft size={11} /><strong>{message.replyTo.author}</strong><span>{message.replyTo.text}</span></div>
                )}
                <div className="message-meta">
                  <strong>{message.author}</strong><time>{message.time}</time>
                  {message.edited && <em className="edited-mark">(изм.)</em>}
                  {message.own && message.status && (
                    <span className={`msg-status ${message.status}`} title={message.status === 'read' ? 'Прочитано' : message.status === 'delivered' ? 'Доставлено' : 'Отправлено'}>
                      {message.status === 'sent' ? <Check size={12} /> : <CheckCheck size={12} />}
                    </span>
                  )}
                </div>
                {message.text && <p>{message.text}</p>}
                {message.attachment && <AttachmentView attachment={message.attachment} />}
                {message.reactions && Object.keys(message.reactions).length > 0 && (
                  <div className="reactions-row">
                    {Object.entries(message.reactions).map(([emoji, names]) => (
                      <button key={emoji} className={names.includes(profileName) ? 'reaction-chip mine' : 'reaction-chip'} title={names.join(', ')} onClick={() => toggleReaction(message, emoji)}>
                        {emoji} <span>{names.length}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {message.author !== 'RIFT' && (
                <div className="msg-actions">
                  {['👍', '❤️', '😂', '🔥'].map((emoji) => (
                    <button key={emoji} className="msg-action emoji" title={`Реакция ${emoji}`} onClick={() => toggleReaction(message, emoji)}>{emoji}</button>
                  ))}
                  <button className="msg-action" title="Ответить" onClick={() => startReply(message)}><CornerUpLeft size={14} /></button>
                  {message.own && <button className="msg-action" title="Редактировать" onClick={() => startEdit(message)}><Pencil size={13} /></button>}
                  {message.own && <button className="msg-action danger" title="Удалить" onClick={() => deleteMessage(message)}><Trash2 size={13} /></button>}
                </div>
              )}
            </article>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {transferLabel && <div className="transfer-status"><span />{transferLabel}</div>}
        {(replyTo || editingId) && (
          <div className="composer-extra">
            {editingId
              ? <span><Pencil size={12} /> Редактирование сообщения</span>
              : <span><CornerUpLeft size={12} /> Ответ для <strong>{replyTo!.author}</strong>: {replyTo!.text.slice(0, 60)}</span>}
            <button type="button" onClick={cancelComposerExtras} title="Отменить"><X size={14} /></button>
          </div>
        )}
        {remoteTypingChannel === activeChannel.id && (
          <div className="typing-line"><span className="typing-dots"><i /><i /><i /></span> Собеседник печатает…</div>
        )}
        <form className="composer" onSubmit={sendMessage}>
          <input ref={fileInputRef} className="file-input" type="file" onChange={sendFile} />
          <button type="button" onClick={() => fileInputRef.current?.click()} title="Отправить файл"><Paperclip size={19} /></button>
          <input
            value={draft}
            onChange={(event) => handleDraftChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') cancelComposerExtras(); }}
            placeholder={editingId ? 'Изменить сообщение…' : `Сообщение в #${activeChannel.name}`}
          />
          <button className="send-button" aria-label="Отправить"><Send size={18} /></button>
        </form>
      </section>

      <aside className="members-panel">
        <div className="member-heading">В СЕТИ — {status === 'прямое соединение' ? 2 : 1}</div>
        <div className="member"><div className="avatar cyan">{profileName.slice(0, 1).toUpperCase()}<span /></div><div><strong>{profileName}</strong><small>строишь RIFT</small></div></div>
        {status === 'прямое соединение' && <div className="member"><div className="avatar orange">С<span /></div><div><strong>Собеседник</strong><small>прямое соединение</small></div></div>}
        <div className="member-note"><Radio size={16} /><p>Никакого центра.<br />Только устройства.</p></div>
      </aside>

      {onboardingOpen && (
        <Onboarding
          onClose={() => setOnboardingOpen(false)}
          onConnect={() => { setOnboardingOpen(false); setSignalOpen(true); }}
        />
      )}

      {channelModalOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setChannelModalOpen(false)}>
          <form className="small-modal" onSubmit={createChannel}>
            <button type="button" className="modal-close" onClick={() => setChannelModalOpen(false)}><X size={20} /></button>
            <div className="modal-kicker">НОВЫЙ ТЕКСТОВЫЙ КАНАЛ</div>
            <h2>Создать пространство</h2>
            <label className="field-label" htmlFor="channel-name">Название канала</label>
            <div className="named-input"><Hash size={17} /><input id="channel-name" autoFocus value={newChannelName} onChange={(event) => setNewChannelName(event.target.value)} placeholder="например, игры" /></div>
            <p className="field-hint">Канал и его история сохраняются только на твоём устройстве. Собеседник увидит его после первого сообщения.</p>
            <button className="primary-action" disabled={!newChannelName.trim()}>Создать канал</button>
          </form>
        </div>
      )}

      {profileModalOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setProfileModalOpen(false)}>
          <form className="small-modal" onSubmit={saveProfile}>
            <button type="button" className="modal-close" onClick={() => setProfileModalOpen(false)}><X size={20} /></button>
            <div className="modal-kicker">ЛОКАЛЬНЫЙ ПРОФИЛЬ</div>
            <h2>Как тебя называть?</h2>
            <label className="field-label" htmlFor="profile-name">Отображаемое имя</label>
            <div className="named-input"><AtSign size={17} /><input id="profile-name" autoFocus maxLength={24} value={profileDraft} onChange={(event) => setProfileDraft(event.target.value)} placeholder="Твоё имя" /></div>
            <p className="field-hint">Имя хранится локально и отправляется собеседнику вместе с сообщением.</p>

            <div className="vs-section-title">Внешний вид</div>
            <label className="field-label">Акцентный цвет</label>
            <div className="accent-row">
              {[{ h: 78, label: 'Кислота' }, { h: 199, label: 'Win11' }, { h: 235, label: 'Blurple' }, { h: 265, label: 'Фиолет' }, { h: 330, label: 'Розовый' }, { h: 25, label: 'Оранж' }].map((preset) => (
                <button type="button" key={preset.h} className={accentHue === preset.h ? 'accent-dot on' : 'accent-dot'} style={{ background: `hsl(${preset.h} 100% 65%)` }} title={preset.label} onClick={() => setAccentHue(preset.h)} />
              ))}
            </div>
            <input type="range" min={0} max={359} step={1} value={accentHue} onChange={(event) => setAccentHue(Number(event.target.value))} className="gain-slider hue-slider" aria-label="Оттенок акцента" />
            <div className="vs-toggle-line">
              <span>Сообщения-пузыри (стиль Win11)</span>
              <button type="button" className={bubbleStyle ? 'vs-switch on' : 'vs-switch'} onClick={() => setBubbleStyle((value) => !value)} aria-pressed={bubbleStyle}><i /></button>
            </div>

            <button className="primary-action" disabled={!profileDraft.trim()}>Сохранить профиль</button>
          </form>
        </div>
      )}

      {screenPickerOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setScreenPickerOpen(false)}>
          <div className="screen-picker">
            <button type="button" className="modal-close" onClick={() => setScreenPickerOpen(false)}><X size={20} /></button>
            <div className="modal-kicker">ДЕМОНСТРАЦИЯ ЭКРАНА</div>
            <h2>Что показать другу?</h2>

            <div className="sp-tabs">
              <button type="button" className={screenTab === 'window' ? 'sp-tab on' : 'sp-tab'} onClick={() => setScreenTab('window')}>Приложения</button>
              <button type="button" className={screenTab === 'screen' ? 'sp-tab on' : 'sp-tab'} onClick={() => setScreenTab('screen')}>Весь экран</button>
            </div>

            <div className="sp-grid">
              {screenLoading && <div className="sp-empty">Загружаю источники…</div>}
              {!screenLoading && screenSources.filter((source) => (screenTab === 'screen' ? source.isScreen : !source.isScreen)).map((source) => (
                <button type="button" key={source.id} className="sp-source" onClick={() => void pickScreenSource(source.id)}>
                  <img className="sp-thumb" src={source.thumbnail} alt="" />
                  <span className="sp-source-name">{source.appIcon && <img className="sp-icon" src={source.appIcon} alt="" />}<span>{source.name}</span></span>
                </button>
              ))}
              {!screenLoading && screenSources.filter((source) => (screenTab === 'screen' ? source.isScreen : !source.isScreen)).length === 0 && (
                <div className="sp-empty">Нет доступных источников</div>
              )}
            </div>

            <div className="sp-quality">
              <label className="field-label">Разрешение</label>
              <div className="sp-chips">
                {RESOLUTION_PRESETS.map((height) => (
                  <button type="button" key={height} className={screenQuality.height === height ? 'sp-chip on' : 'sp-chip'} onClick={() => void changeScreenQuality({ ...screenQuality, height })}>{height}p</button>
                ))}
              </div>
              <label className="field-label">Кадры в секунду</label>
              <div className="sp-chips">
                {FPS_PRESETS.map((fps) => (
                  <button type="button" key={fps} className={screenQuality.fps === fps ? 'sp-chip on' : 'sp-chip'} onClick={() => void changeScreenQuality({ ...screenQuality, fps })}>{fps} fps</button>
                ))}
              </div>
              <label className="field-label">Кодек видео</label>
              <div className="sp-chips">
                {(['auto', 'H264', 'VP9', 'AV1'] as const).map((codec) => (
                  <button type="button" key={codec} className={screenCodec === codec ? 'sp-chip on' : 'sp-chip'} onClick={() => setScreenCodec(codec)}>{codec === 'auto' ? 'Авто' : codec}</button>
                ))}
              </div>
              <div className="vs-toggle-line">
                <span>Транслировать звук приложения</span>
                <button type="button" className={screenQuality.audio ? 'vs-switch on' : 'vs-switch'} onClick={() => setScreenQuality({ ...screenQuality, audio: !screenQuality.audio })} aria-pressed={screenQuality.audio}><i /></button>
              </div>
              <p className="field-hint">Разрешение/fps можно менять на лету во время трансляции. Кодек и звук применяются при следующем запуске.</p>
            </div>
          </div>
        </div>
      )}

      {audioModalOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeAudioModal()}>
          <div className="voice-settings">
            <button type="button" className="modal-close" onClick={closeAudioModal}><X size={20} /></button>
            <div className="modal-kicker">ГОЛОС И ВИДЕО</div>
            <h2>Настройки голоса</h2>

            <div className="vs-grid">
              <div>
                <label className="field-label" htmlFor="audio-input"><Mic size={15} /> Микрофон</label>
                <div className="named-input select">
                  <select id="audio-input" value={inputDeviceId} onChange={(event) => void changeInputDevice(event.target.value)}>
                    <option value="">По умолчанию</option>
                    {audioInputs.map((device, index) => (
                      <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Микрофон ${index + 1}`}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="field-label" htmlFor="audio-output"><Volume2 size={15} /> Динамик</label>
                <div className="named-input select">
                  <select id="audio-output" value={outputDeviceId} onChange={(event) => setOutputDeviceId(event.target.value)}>
                    <option value="">По умолчанию</option>
                    {audioOutputs.map((device, index) => (
                      <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Динамик ${index + 1}`}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="vs-grid">
              <div>
                <label className="field-label" htmlFor="mic-gain">Громкость микрофона · {Math.round(micGain * 100)}%</label>
                <input id="mic-gain" type="range" min={0} max={2} step={0.05} value={micGain} onChange={(event) => changeMicGain(Number(event.target.value))} className="gain-slider" />
              </div>
              <div>
                <label className="field-label" htmlFor="friend-volume">Громкость друга · {deafened ? 'заглушено' : `${Math.round(remoteVolume * 100)}%`}</label>
                <input id="friend-volume" type="range" min={0} max={1} step={0.05} value={remoteVolume} onChange={(event) => setRemoteVolume(Number(event.target.value))} className="gain-slider" disabled={deafened} />
              </div>
            </div>

            <div className="vs-mictest">
              <button type="button" className={micTestOn ? 'vs-test-btn on' : 'vs-test-btn'} onClick={() => setMicTestOn((value) => !value)}>{micTestOn ? 'Остановить' : 'Проверка микрофона'}</button>
              <div className="vs-meter"><span style={{ width: `${Math.round(inputLevel)}%` }} className={inputLevel > (vadAuto ? 12 : vadThreshold) ? 'over' : ''} /></div>
            </div>
            <p className="field-hint">Скажи что-нибудь — если полоска доходит до порога, тебя слышно.</p>

            <div className="vs-section-title">Режим ввода</div>
            <div className="vs-modes">
              <button type="button" className={inputMode === 'voice' ? 'vs-mode on' : 'vs-mode'} onClick={() => setInputMode('voice')}>
                <strong>Активация по голосу</strong><span>Микрофон открывается, когда ты говоришь</span>
              </button>
              <button type="button" className={inputMode === 'ptt' ? 'vs-mode on' : 'vs-mode'} onClick={() => setInputMode('ptt')}>
                <strong>Рация (push-to-talk)</strong><span>Говоришь, пока держишь пробел</span>
              </button>
            </div>

            {inputMode === 'voice' && (
              <div className="vs-block">
                <div className="vs-toggle-line">
                  <span>Автоматически определять чувствительность</span>
                  <button type="button" className={vadAuto ? 'vs-switch on' : 'vs-switch'} onClick={() => setVadAuto((value) => !value)} aria-pressed={vadAuto}><i /></button>
                </div>
                {!vadAuto && (
                  <>
                    <label className="field-label" htmlFor="vad-threshold">Чувствительность · порог {vadThreshold}</label>
                    <input id="vad-threshold" type="range" min={0} max={80} step={1} value={vadThreshold} onChange={(event) => setVadThreshold(Number(event.target.value))} className="gain-slider" />
                  </>
                )}
              </div>
            )}

            <div className="vs-section-title">Обработка звука</div>
            <label className="field-label" htmlFor="ns-mode">Шумоподавление</label>
            <div className="named-input select">
              <select id="ns-mode" value={noiseSuppressionOn ? 'rnnoise' : 'off'} onChange={(event) => { if ((event.target.value === 'rnnoise') !== noiseSuppressionOn) void toggleNoiseSuppression(); }}>
                <option value="rnnoise">RNNoise (рекомендуется)</option>
                <option value="off">Выключено</option>
              </select>
            </div>
            <div className="vs-toggle-line">
              <span>Эхоподавление</span>
              <button type="button" className={echoCancellation ? 'vs-switch on' : 'vs-switch'} onClick={() => changeEchoCancellation(!echoCancellation)} aria-pressed={echoCancellation}><i /></button>
            </div>
            <div className="vs-toggle-line">
              <span>Автоматическая регулировка усиления</span>
              <button type="button" className={autoGain ? 'vs-switch on' : 'vs-switch'} onClick={() => changeAutoGain(!autoGain)} aria-pressed={autoGain}><i /></button>
            </div>
            <p className="field-hint">Эхо/AGC применяются к текущему звонку сразу; полностью — при следующем входе в звонок.</p>
          </div>
        </div>
      )}

      {signalOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSignalOpen(false)}>
          <div className="signal-modal">
            <button className="modal-close" onClick={() => setSignalOpen(false)}><X size={20} /></button>
            <div className="modal-kicker">БЫСТРОЕ P2P-СОЕДИНЕНИЕ</div>
            <h2>Одна ссылка — один клик</h2>
            <p className="modal-lead">Приглашение живёт 10 минут. Публичные узлы только знакомят устройства; сообщения, файлы и звонки через них не проходят.</p>

            {signalMode === 'idle' && (
              <div className="link-pairing">
                <button className="giant-action create-link-action" onClick={createLinkInvite}><UserPlus /> Создать ссылку для друга</button>
                <div className="or-line"><span>или</span></div>
                <label>Друг уже прислал ссылку?</label>
                <div className="link-join-row"><input value={linkDraft} onChange={(event) => setLinkDraft(event.target.value)} placeholder="rift://join/…" /><button onClick={() => joinFromLink()} disabled={!linkDraft.trim()}>Подключиться</button></div>
                <details className="offline-fallback"><summary>Без публичных узлов: QR или технический код</summary><div className="choice-grid"><button onClick={createOffer}><ScanQrCode /><strong>Показать QR</strong><span>Для устройств рядом</span></button><button onClick={() => { setSignalMode('guest-offer'); setGeneratedSignal(''); setScannerMode('offer'); }}><ScanQrCode /><strong>Сканировать QR</strong><span>Для устройств рядом</span></button></div></details>
              </div>
            )}

            {signalMode === 'host-offer' && (
              <div className="signal-flow">
                {shareLink ? <>
                  <div className="link-ready-mark"><Check size={24} /></div>
                  <h3 className="link-ready-title">Ссылка готова</h3>
                  <p className="link-ready-copy">Отправь её другу. Он просто нажмёт — ответ вернётся автоматически.</p>
                  <div className="share-link-box"><input readOnly value={shareLink} /><button onClick={copyShareLink}>{linkCopied ? <Check /> : <Copy />}{linkCopied ? 'Скопировано' : 'Скопировать'}</button></div>
                  <div className="waiting-line"><span /> Ждём, когда друг откроет ссылку…</div>
                </> : <>
                  <div className="human-step active-step"><span>1</span><div><strong>Покажи этот QR другу</strong><p>Если он далеко — скачай картинку и отправь её.</p></div></div>
                  <div id="rift-offer-qr" className="signal-qr"><QRCodeSVG value={packedSignal} size={288} level="L" marginSize={3} /><span>ПРИГЛАШЕНИЕ RIFT</span></div>
                  <button className="giant-action" onClick={() => downloadQrPng('rift-offer-qr', 'RIFT-приглашение.png')}><Download /> Скачать QR-картинку</button>
                  <div className="human-step"><span>2</span><div><strong>Получи ответ друга</strong><p>Наведи камеру на его QR или выбери присланную картинку.</p></div></div>
                  <button className="paste-action" onClick={() => setScannerMode('answer')}><ScanQrCode /> Сканировать QR-ответ</button>
                  <details className="advanced-signal"><summary>Технический код</summary><textarea readOnly value={generatedSignal} /><textarea value={signalText} onChange={(event) => setSignalText(event.target.value)} placeholder="Ответ друга…" /><button onClick={() => acceptAnswer()}>Подключиться вручную</button></details>
                </>}
              </div>
            )}

            {signalMode === 'guest-offer' && !generatedSignal && (
              <div className="signal-flow">
                <div className="human-step active-step"><span>1</span><div><strong>Отсканируй приглашение</strong><p>Наведи камеру на QR друга или выбери присланную картинку.</p></div></div>
                <button className="giant-action" onClick={() => setScannerMode('offer')}><ScanQrCode /> Открыть QR-сканер</button>
                <details className="advanced-signal"><summary>Вставить технический код вручную</summary><textarea value={signalText} onChange={(event) => setSignalText(event.target.value)} placeholder="Приглашение…" /><button onClick={() => acceptOffer()}>Продолжить</button></details>
              </div>
            )}

            {signalMode === 'guest-offer' && generatedSignal && (
              <div className="signal-flow">
                <div className="human-step active-step"><span>2</span><div><strong>Покажи ответ другу</strong><p>Он сканирует этот QR — и устройства соединятся.</p></div></div>
                <div id="rift-answer-qr" className="signal-qr"><QRCodeSVG value={packedSignal} size={288} level="L" marginSize={3} /><span>ОТВЕТ RIFT</span></div>
                <button className="giant-action" onClick={() => downloadQrPng('rift-answer-qr', 'RIFT-ответ.png')}><Download /> Скачать QR-картинку</button>
                <div className="waiting-line"><span /> После этого соединение включится автоматически</div>
                <details className="advanced-signal"><summary>Технический код</summary><textarea readOnly value={generatedSignal} /></details>
              </div>
            )}

            {signalMode === 'host-answer' && <div className="success-state"><div><Link2 size={30} /></div><h3>Ответ принят</h3><p>Окно можно закрыть — устройства договариваются напрямую.</p></div>}
            {error && <div className="error-banner">{error}</div>}
            {signalMode !== 'idle' && <button className="back-link" onClick={() => { pairingStopRef.current?.(); pairingStopRef.current = null; setSignalMode('idle'); setShareLink(''); setSignalText(''); setGeneratedSignal(''); setError(''); }}>← начать заново</button>}
            {scannerMode && <QrScanner title={scannerMode === 'offer' ? 'Сканируй приглашение' : 'Сканируй ответ друга'} onResult={handleQrResult} onCancel={() => setScannerMode(null)} />}
          </div>
        </div>
      )}

      {error && !signalOpen && <div className="toast" onClick={() => setError('')}>{error}<X size={15} /></div>}
    </main>
  );
}

export default App;
