import {
  AtSign,
  Camera,
  CameraOff,
  Check,
  CircleHelp,
  Copy,
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
  PhoneOff,
  Plus,
  Radio,
  Search,
  ScanQrCode,
  Send,
  Settings,
  Sparkles,
  Users,
  UserPlus,
  Video,
  Volume2,
  Waves,
  X,
} from 'lucide-react';
import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { createRnnoiseTrack, type RnnoiseHandle } from './audio/rnnoise';
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
  const [remoteAudioOn, setRemoteAudioOn] = useState(false);
  const [remoteVideoOn, setRemoteVideoOn] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [callMinimized, setCallMinimized] = useState(false);
  const [transferLabel, setTransferLabel] = useState('');
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const rawMicTrackRef = useRef<MediaStreamTrack | null>(null);
  const rnnoiseRef = useRef<RnnoiseHandle | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef(new MediaStream());
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingTransfersRef = useRef(new Map<string, PendingTransfer>());
  const pairingStopRef = useRef<null | (() => void)>(null);
  const politePeerRef = useRef(false);
  const makingMediaOfferRef = useRef(false);
  const handledLinksRef = useRef(new Set<string>());
  const disconnectedTimerRef = useRef<number | null>(null);
  const activeChannelRef = useRef(activeChannelId);
  const activeChannel = channels.find((channel) => channel.id === activeChannelId) || channels[0];
  const messages = messagesByChannel[activeChannel?.id] || [];
  const packedSignal = useMemo(() => generatedSignal ? packSignal(generatedSignal) : '', [generatedSignal]);

  const attachCallStreams = useCallback(() => {
    if (localVideoRef.current && localVideoRef.current.srcObject !== localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
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

  const sendCurrentMediaOffer = useCallback(async () => {
    const pc = pcRef.current;
    const channel = channelRef.current;
    if (!pc || channel?.readyState !== 'open' || pc.signalingState !== 'stable' || makingMediaOfferRef.current) return;
    makingMediaOfferRef.current = true;
    try {
      await pc.setLocalDescription(await pc.createOffer());
      channel.send(JSON.stringify({ type: 'rtc-offer', description: pc.localDescription }));
    } finally {
      makingMediaOfferRef.current = false;
    }
  }, []);

  useEffect(() => {
    activeChannelRef.current = activeChannelId;
  }, [activeChannelId]);

  const receiveMessage = useCallback(async (event: MessageEvent) => {
    try {
      const payload = JSON.parse(event.data) as {
        type: string;
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
      };
      if (payload.type === 'call-state') {
        setRemoteAudioOn(Boolean(payload.audio));
        setRemoteVideoOn(Boolean(payload.video));
        return;
      }
      if (payload.type === 'rtc-renegotiate-request') {
        if (politePeerRef.current) return;
        void (async () => {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            if (pcRef.current?.signalingState === 'stable') {
              await sendCurrentMediaOffer();
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
      if (payload.type === 'message' && payload.text) {
        const targetId = payload.channelId || activeChannelRef.current;
        if (payload.channelName) {
          setChannels((items) => items.some((item) => item.id === targetId)
            ? items
            : [...items, { id: targetId, name: payload.channelName! }]);
        }
        setMessagesByChannel((all) => ({
          ...all,
          [targetId]: [...(all[targetId] || []), {
            id: crypto.randomUUID(),
            author: payload.author || 'Собеседник',
            text: payload.text!,
            time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
          }],
        }));
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
    pc.onconnectionstatechange = () => {
      if (pcRef.current !== pc) return;
      const labels: Record<string, string> = {
        new: 'ожидание', connecting: 'соединяемся…', connected: 'прямое соединение', closed: 'соединение закрыто',
      };
      if (pc.connectionState === 'connected') {
        if (disconnectedTimerRef.current !== null) window.clearTimeout(disconnectedTimerRef.current);
        disconnectedTimerRef.current = null;
        setStatus(labels.connected);
        return;
      }
      if (pc.connectionState === 'disconnected') {
        setStatus('восстанавливаем связь…');
        if (disconnectedTimerRef.current !== null) window.clearTimeout(disconnectedTimerRef.current);
        disconnectedTimerRef.current = window.setTimeout(() => {
          if (pcRef.current === pc && pc.connectionState === 'disconnected') setStatus('связь потеряна');
        }, 8_000);
        return;
      }
      if (pc.connectionState === 'failed') {
        setStatus('не удалось соединиться');
        setError('Сети не пропустили прямое P2P-соединение. Попробуйте другую сеть или один Wi-Fi.');
        return;
      }
      setStatus(labels[pc.connectionState] || pc.connectionState);
    };
    pc.ondatachannel = (event) => bindChannel(event.channel);
    pc.ontrack = (event) => {
      if (!remoteStreamRef.current.getTracks().some((track) => track.id === event.track.id)) {
        remoteStreamRef.current.addTrack(event.track);
      }
      const showTrack = () => {
        if (event.track.kind === 'audio') setRemoteAudioOn(true);
        if (event.track.kind === 'video') setRemoteVideoOn(true);
        window.requestAnimationFrame(attachCallStreams);
      };
      const hideTrack = () => {
        if (event.track.kind === 'audio') setRemoteAudioOn(false);
        if (event.track.kind === 'video') setRemoteVideoOn(false);
      };
      event.track.onunmute = showTrack;
      event.track.onmute = hideTrack;
      event.track.onended = hideTrack;
      if (!event.track.muted) showTrack();
      window.requestAnimationFrame(attachCallStreams);
    };
    return pc;
  }, [attachCallStreams, bindChannel]);

  const renegotiateMedia = async () => {
    const channel = channelRef.current;
    if (channel?.readyState !== 'open') return;
    if (politePeerRef.current) {
      channel.send(JSON.stringify({ type: 'rtc-renegotiate-request' }));
      return;
    }
    await sendCurrentMediaOffer();
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

  const enableMedia = async (kind: 'mic' | 'camera') => {
    setError('');
    try {
      const stream = localStreamRef.current || new MediaStream();
      const media = await navigator.mediaDevices.getUserMedia({
        audio: kind === 'mic' && !stream.getAudioTracks().length ? {
          autoGainControl: true,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: !noiseSuppressionOn,
          sampleRate: 48000,
        } : false,
        video: kind === 'camera' && !stream.getVideoTracks().length,
      });
      for (const capturedTrack of media.getTracks()) {
        let track = capturedTrack;
        if (capturedTrack.kind === 'audio') {
          rawMicTrackRef.current = capturedTrack;
          if (noiseSuppressionOn) {
            try {
              rnnoiseRef.current = await createRnnoiseTrack(capturedTrack);
              track = rnnoiseRef.current.track;
            } catch (rnnoiseError) {
              console.warn('[RIFT] RNNoise unavailable, using browser suppression', rnnoiseError);
              await capturedTrack.applyConstraints({ noiseSuppression: true }).catch(() => undefined);
              setNoiseSuppressionOn(false);
            }
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
      setMicOn(stream.getAudioTracks().some((track) => track.enabled));
      setCameraOn(stream.getVideoTracks().some((track) => track.enabled));
      setCallOpen(true);
      window.requestAnimationFrame(attachCallStreams);
      sendCallState(
        stream.getAudioTracks().some((track) => track.enabled),
        stream.getVideoTracks().some((track) => track.enabled) || sharing,
      );
      await renegotiateMedia();
    } catch (mediaError) {
      const reason = mediaError instanceof DOMException && mediaError.name === 'NotAllowedError'
        ? 'Разреши RIFT доступ к микрофону и камере в настройках Windows'
        : 'Не удалось включить камеру или микрофон — проверь, что устройство не занято';
      setError(reason);
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
    audioTrack.enabled = true;
    setMicOn(true);
    sendCallState(true, cameraOn || sharing);
  };

  const toggleMic = async () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return enableMedia('mic');
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
    sendCallState(track.enabled, cameraOn || sharing);
  };

  const toggleNoiseSuppression = async () => {
    const rawTrack = rawMicTrackRef.current;
    const stream = localStreamRef.current;
    const currentTrack = stream?.getAudioTracks()[0];
    if (!rawTrack || !stream || !currentTrack) {
      setNoiseSuppressionOn(!noiseSuppressionOn);
      return;
    }

    const enabled = currentTrack.enabled;
    try {
      let nextTrack: MediaStreamTrack;
      if (noiseSuppressionOn) {
        rnnoiseRef.current?.stop();
        rnnoiseRef.current = null;
        nextTrack = rawTrack;
        await rawTrack.applyConstraints({ noiseSuppression: true }).catch(() => undefined);
      } else {
        await rawTrack.applyConstraints({ noiseSuppression: false }).catch(() => undefined);
        rnnoiseRef.current = await createRnnoiseTrack(rawTrack);
        nextTrack = rnnoiseRef.current.track;
      }
      nextTrack.enabled = enabled;
      stream.removeTrack(currentTrack);
      stream.addTrack(nextTrack);
      const sender = pcRef.current?.getTransceivers()
        .find((item) => item.receiver.track.kind === 'audio')?.sender;
      await sender?.replaceTrack(nextTrack);
      setNoiseSuppressionOn(!noiseSuppressionOn);
      window.requestAnimationFrame(attachCallStreams);
    } catch (rnnoiseError) {
      console.error('[RIFT] failed to switch RNNoise', rnnoiseError);
      setError('Не удалось переключить RNNoise — оставил текущее аудио без изменений');
    }
  };

  const toggleCamera = async () => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) return enableMedia('camera');
    track.enabled = !track.enabled;
    setCameraOn(track.enabled);
    sendCallState(micOn, track.enabled || sharing);
  };

  const toggleScreen = async () => {
    if (sharing) {
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
      const cameraTrack = localStreamRef.current?.getVideoTracks()[0] || null;
      const videoSender = pcRef.current?.getTransceivers().find((item) => item.receiver.track.kind === 'video')?.sender;
      if (videoSender) await videoSender.replaceTrack(cameraTrack);
      if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
      setSharing(false);
      sendCallState(micOn, cameraOn);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      screenStreamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const sender = pcRef.current?.getTransceivers().find((item) => item.receiver.track.kind === 'video')?.sender;
      const transceiver = pcRef.current?.getTransceivers().find((item) => item.receiver.track.kind === 'video');
      if (transceiver) {
        transceiver.direction = 'sendrecv';
        await transceiver.sender.replaceTrack(track);
      }
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
  };

  const hangUp = () => {
    sendCallState(false, false);
    pcRef.current?.getSenders().forEach((sender) => {
      if (sender.track?.kind === 'audio' || sender.track?.kind === 'video') void sender.replaceTrack(null);
    });
    rnnoiseRef.current?.stop();
    rnnoiseRef.current = null;
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

  const sendMessage = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const message: Message = {
      id: crypto.randomUUID(), author: profileName, text, own: true,
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    };
    setMessagesByChannel((all) => ({
      ...all,
      [activeChannel.id]: [...(all[activeChannel.id] || []), message],
    }));
    if (channelRef.current?.readyState === 'open') {
      channelRef.current.send(JSON.stringify({
        type: 'message',
        text,
        author: profileName,
        channelId: activeChannel.id,
        channelName: activeChannel.name,
      }));
    }
    setDraft('');
  };

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
    if (!('__TAURI_INTERNALS__' in window)) return undefined;
    let unlisten: undefined | (() => void);
    const openLinks = (urls: string[]) => {
      const link = urls.find((url) => url.startsWith('rift://join/'));
      if (!link || handledLinksRef.current.has(link)) return;
      handledLinksRef.current.add(link);
      setSignalOpen(true);
      setLinkDraft(link);
      void joinFromLink(link);
    };
    void import('@tauri-apps/plugin-deep-link').then(async ({ getCurrent, onOpenUrl }) => {
      openLinks((await getCurrent()) || []);
      unlisten = await onOpenUrl(openLinks);
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => () => {
    rnnoiseRef.current?.stop();
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
          <button><Headphones size={17} /></button>
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
            <div><span className={remoteAudioOn ? 'voice-dot active' : 'voice-dot'} /><strong>Голосовой звонок</strong><small>{remoteAudioOn ? 'друг говорит' : 'ожидаем друга'}</small></div>
            <div className="call-bar-controls">
              <button onClick={toggleMic} className={micOn ? 'enabled' : ''} title={micOn ? 'Выключить микрофон' : 'Включить микрофон'}>{micOn ? <Mic /> : <MicOff />}</button>
              <button onClick={() => void toggleNoiseSuppression()} className={noiseSuppressionOn ? 'enabled accent' : ''} title={`RNNoise: ${noiseSuppressionOn ? 'включён' : 'выключен'}`}><Waves /></button>
              <button onClick={() => setCallMinimized(false)} title="Развернуть звонок"><Maximize2 /></button>
              <button onClick={hangUp} className="danger" title="Выйти из звонка"><PhoneOff /></button>
            </div>
          </section>
        )}

        {callOpen && !callMinimized && (
          <section className="call-stage">
            <div className="video-grid">
              <div className="video-tile remote">
                <video ref={remoteVideoRef} autoPlay muted playsInline />
                {!remoteVideoOn && <div className="video-empty"><div className="orb">?</div><span>{remoteAudioOn ? 'Друг в голосовом звонке' : 'Ожидаем друга в звонке'}</span></div>}
                <span className="video-label">Собеседник</span>
              </div>
              <div className="video-tile local">
                <video ref={localVideoRef} autoPlay muted playsInline />
                {!cameraOn && !sharing && <div className="video-empty"><div className="orb own">Я</div></div>}
                <span className="video-label">{profileName} {sharing && '· экран'}</span>
              </div>
            </div>
            <div className="call-controls">
              <button onClick={toggleMic} className={micOn ? 'enabled' : ''}>{micOn ? <Mic /> : <MicOff />}</button>
              <button onClick={() => void toggleNoiseSuppression()} className={noiseSuppressionOn ? 'enabled accent' : ''} title={`Шумоподавление RNNoise: ${noiseSuppressionOn ? 'включено' : 'выключено'}`}><Waves /></button>
              <button onClick={toggleCamera} className={cameraOn ? 'enabled' : ''}>{cameraOn ? <Camera /> : <CameraOff />}</button>
              <button onClick={toggleScreen} className={sharing ? 'enabled accent' : ''}><MonitorUp /></button>
              <button onClick={() => setCallMinimized(true)} title="Свернуть звонок"><Minimize2 /></button>
              <button onClick={hangUp} className="danger"><PhoneOff /></button>
            </div>
          </section>
        )}

        <div className="messages">
          <div className="channel-intro">
            <div className="hash-block"><Hash size={30} /></div>
            <h1>{activeChannel.name}</h1>
            <p>{messages.length ? 'Локальная история этого канала сохранена на устройстве.' : 'Пока пусто. Начни разговор — история сохранится на этом устройстве.'}</p>
            <div className="privacy-chip"><Sparkles size={14} /> P2P-FIRST</div>
          </div>
          {messages.map((message) => (
            <article className={`message ${message.own ? 'own' : ''}`} key={message.id}>
              <div className={`message-avatar ${message.author === 'RIFT' ? 'system' : ''}`}>{message.author.slice(0, 1)}</div>
              <div>
                <div className="message-meta"><strong>{message.author}</strong><time>{message.time}</time></div>
                {message.text && <p>{message.text}</p>}
                {message.attachment && <AttachmentView attachment={message.attachment} />}
              </div>
            </article>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {transferLabel && <div className="transfer-status"><span />{transferLabel}</div>}
        <form className="composer" onSubmit={sendMessage}>
          <input ref={fileInputRef} className="file-input" type="file" onChange={sendFile} />
          <button type="button" onClick={() => fileInputRef.current?.click()} title="Отправить файл"><Paperclip size={19} /></button>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`Сообщение в #${activeChannel.name}`} />
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
            <button className="primary-action" disabled={!profileDraft.trim()}>Сохранить профиль</button>
          </form>
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
