# RIFT handoff

Дата: 2026-07-22

## Что это вообще за приложение

RIFT — настольный мессенджер в духе Discord для небольшой компании друзей, но без обязательной регистрации и без центрального сервера, который хранит переписку. Основной сценарий: пользователь ставит Windows-приложение, создаёт короткую ссылку-приглашение, отправляет её другу, после чего они получают прямой зашифрованный канал для сообщений, файлов, голосового звонка, камеры и демонстрации экрана.

Это пока P2P-прототип, а не полный клон Discord. Цель ближайшей версии — надёжный разговор двух устройств и понятный интерфейс. Каналы и история сейчас локальные; полноценные многопользовательские серверы, роли, синхронизация истории и облачное хранение требуют отдельной архитектуры и отложены.

## На чём строится RIFT

- **Tauri 2 + Rust** — нативное Windows-окно, installer, deep links и безопасные подписанные обновления.
- **React 18 + TypeScript + Vite** — интерфейс.
- **WebRTC** — прямые DTLS-SRTP аудио/видео/screen-share соединения и RTCDataChannel для сообщений/файлов.
- **Nostr public relays** — только временный rendezvous/signaling для коротких приглашений; содержимое offer/answer дополнительно шифруется секретом из ссылки.
- **Web Crypto AES-GCM** — шифрование signaling payload.
- **STUN Cloudflare/Google** — обнаружение P2P-маршрута. TURN пока отсутствует.
- **RNNoise WASM + AudioWorklet** — локальное шумоподавление до отправки микрофона.
- **Playwright** — настоящий тест двух независимых браузерных клиентов.
- **GitHub Releases + Tauri updater** — доставка подписанных обязательных обновлений после публикации репозитория.
- **Buzz** — Apache-2.0 референс архитектуры и UX: voice lifecycle, compact voice bar, reconnect/cleanup, устройства, сообщения, sidebar, notifications и updater. Его серверный код и аудиорелей не являются основой RIFT.

Главный принцип: данные пользователя по возможности остаются на устройствах; публичная инфраструктура используется только для знакомства пиров, а live-трафик старается идти напрямую.

## Где всё находится

- Основной проект: `C:\Users\FSOS\Documents\Lua\rift-messenger`
- Референс Buzz: `C:\Users\FSOS\Desktop\buzz-main`
- Аудит Buzz: `C:\Users\FSOS\Documents\Lua\rift-messenger\docs\BUZZ_AUDIT.md`
- Приватный ключ подписи обновлений: `C:\Users\FSOS\.tauri\rift.key`
- Публичный ключ: `C:\Users\FSOS\.tauri\rift.key.pub`
- Старые/новые локальные установщики обычно складывались в `C:\Users\FSOS\Documents\Lua\rift-messenger\releases`
- Главный React-клиент: `src\App.tsx`
- P2P short-link signaling через Nostr: `src\relayPairing.ts`
- Старый ручной SDP/QR signaling: `src\pairing.ts`
- RNNoise: `src\audio\rnnoise.ts`, `src\audio\rnnoise-worklet.ts`, `src\audio\rnnoise-processor.ts`
- Обязательный updater: `src\useMandatoryUpdater.ts`
- Tauri config: `src-tauri\tauri.conf.json`
- GitHub Actions release: `.github\workflows\release.yml`
- Голосовой E2E: `tests\voice-call.spec.ts`

Локальному trusted-агенту разрешено использовать приватный signing key по указанному пути для сборки и загрузки GitHub secret. Нельзя печатать содержимое ключа в ответах, логах, source-файлах или коммитах. Папка `.tauri` находится вне проекта, а `.gitignore` дополнительно исключает `*.key` и `*.key.pub`.

## Что уже сделано

- Tauri 2 + React/Vite Windows-приложение.
- Короткое приглашение вида `rift://join/...`; offer/answer передаются через несколько бесплатных Nostr-релеев и шифруются AES-GCM.
- Сообщения и файлы идут P2P по RTCDataChannel.
- Исправлен `RTCPeerConnection is not a constructor` с понятной ошибкой для неподдерживаемого WebView.
- Исправлен главный баг голоса: guest больше не создаёт дублирующие transceiver; оба аудионаправления реально `sendrecv`.
- Микрофон не включается автоматически. В звонок входят явной кнопкой.
- Есть микрофон, камера, демонстрация экрана, завершение и сворачивание звонка.
- Remote audio вынесен в отдельный скрытый `<audio>`, поэтому звук не пропадает при сворачивании интерфейса.
- Добавлена renegotiation через зашифрованный data channel; offer создаёт host, guest запрашивает renegotiation, чтобы не было glare.
- Добавлен 8-секундный grace period для временного WebRTC `disconnected`.
- Реальный Playwright E2E с двумя Edge-контекстами прошёл: short-link pairing, отсутствие auto-voice, оба входят, оба получают live remote audio, звонок сворачивается.
- Добавлены Tauri updater/process plugins, blocking mandatory update UI, updater signing pubkey и GitHub Actions release workflow.
- Версия поднята до `0.5.0`.
- Добавлены THIRD_PARTY_NOTICES и лицензии Buzz/RNNoise/Jitsi.
- Проведён аудит Buzz. Buzz voice нельзя копировать целиком: он использует собственный Rust/WebSocket audio relay и серверную инфраструктуру. Полезные UX/reliability-паттерны перечислены в `docs\BUZZ_AUDIT.md`.
- Подключён настоящий RNNoise WASM через AudioWorklet. Production frontend build проходит. Кнопка с волнами есть в полном и свёрнутом звонке. При ошибке RNNoise используется browser noise suppression.

## Что не успел / делать следующим

1. Проверить RNNoise на настоящем микрофоне в Tauri Windows-приложении: toggle on/off, mute, hangup, повторный вход. Особое внимание — чтобы raw mic и processed track всегда останавливались.
2. Добавить устройства input/output, mic gain и push-to-talk по паттернам Buzz.
3. Добавить bounded ICE restart/reconnect. Сейчас есть только grace period.
4. Создать публичный GitHub repo `DeLorean-bot/rift-messenger`, добавить remote и push. Отдельный локальный repo уже инициализирован внутри `rift-messenger` на ветке `main`.
5. `gh` CLI на машине отсутствовал. Нужно установить и авторизовать либо создать repo через GitHub UI. GitHub connector видел аккаунт `DeLorean-bot`, но его API не умел создавать repo/release.
6. В GitHub Actions добавить secret `TAURI_SIGNING_PRIVATE_KEY` из файла `C:\Users\FSOS\.tauri\rift.key`. Сам приватный ключ никогда не коммитить. Password пустой; workflow сейчас ссылается также на `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, можно задать пустое значение или убрать reference после проверки.
7. Сделать tag `v0.5.0` и push. Workflow должен собрать release assets и `latest.json`.
8. Собрать локальный подписанный installer 0.5.0 и проверить install/update. Пример:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH='C:\Users\FSOS\.tauri\rift.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''
$env:CARGO_TARGET_DIR='C:\Users\FSOS\Documents\Lua\rift-messenger\src-tauri\target-v0.5'
npm run desktop:build
```

9. Старый installer 0.4.0 нельзя удалённо заблокировать: в нём updater ещё не существовал. Обязительное обновление начинает работать только с 0.5.0.

## Важное про “без серверов”

- Signaling сейчас бесплатный и распределён через публичные Nostr relays.
- Медиа идёт напрямую P2P.
- STUN: Cloudflare + Google.
- Надёжно соединить любые две сети/NAT без TURN невозможно. Проверенный публичный `openrelay.metered.ca` не дал relay candidate, поэтому он не добавлен.
- Если нужна честная гарантия “работает везде”, позже потребуется TURN. Можно сделать optional user-configured TURN или собственный дешёвый coturn; нельзя обещать 100% доступность без него.

## Команды проверки

```powershell
cd C:\Users\FSOS\Documents\Lua\rift-messenger
npm run build
npm run test:e2e
cargo check --manifest-path src-tauri\Cargo.toml
npm run desktop:dev
```

## Текущий статус проверки

- `npm run build`: PASS после RNNoise.
- `cargo check`: PASS; Cargo.lock обновлён на rift-messenger 0.5.0.
- `npm run test:e2e`: PASS после RNNoise. Один первый прогон упал из-за временного обрыва публичного signaling relay; повторный полный прогон подтвердил двусторонний live audio через RNNoise. Диагностический Proxy и stats-логи из теста удалены.
- Windows installer 0.5.0: ещё не собран.
- GitHub repo/release: ещё не создан.

## Готовый промпт следующему агенту

```text
Продолжай разработку RIFT в C:\Users\FSOS\Documents\Lua\rift-messenger. Сначала полностью прочитай HANDOFF.md и docs\BUZZ_AUDIT.md, затем самостоятельно проверь фактическое состояние Git и файлов — не полагайся слепо на описание. Не удаляй готовые функции и не меняй P2P-архитектуру без причины. Сначала запусти npm run build, cargo check --manifest-path src-tauri\Cargo.toml и npm run test:e2e. Исправь найденные ошибки. Затем продолжай незавершённые пункты из HANDOFF по порядку: GitHub-репозиторий DeLorean-bot/rift-messenger, secrets для Tauri signing key, GitHub Releases updater, подписанный installer 0.5.0 и проверка обновления. Приватный ключ разрешено использовать локально из C:\Users\FSOS\.tauri\rift.key, но запрещено печатать, коммитить или класть в логи его содержимое. После каждого крупного изменения снова проверяй build/E2E и обновляй HANDOFF фактическим статусом.
```

## Лицензии

- Buzz: Apache-2.0, использовался как архитектурный/UX reference.
- `@jitsi/rnnoise-wasm`: Apache-2.0.
- Upstream Xiph RNNoise: BSD-3-Clause.
- Код OBS RNNoise integration напрямую не копировался, потому что OBS GPL-2.0. Использована совместимая WASM-реализация и собственная интеграция.
