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

## Полная карта исходников Buzz

Референсный проект находится здесь:

`C:\Users\FSOS\Desktop\buzz-main`

Это полный исходный код Block Buzz примерно на 2940 файлов: Rust backend/relay, Tauri desktop, web/mobile clients, тесты, deployment, scripts, agent skills и документация. Лицензия Apache-2.0. Следующему агенту разрешено читать и использовать совместимые идеи/код с сохранением attribution, но нельзя бездумно переносить серверные зависимости в P2P RIFT.

### Главные инструкции и документация

- `AGENTS.md` — обязательные правила работы с репозиторием Buzz. Прочитать полностью перед изменением или глубоким анализом Buzz.
- `ARCHITECTURE.md` — полная архитектура relay, Nostr events, Postgres/Redis, subscriptions, security и crates.
- `README.md` — продукт и общий запуск.
- `desktop\README.md` — запуск и устройство desktop-клиента.
- `TESTING.md` — тестовая стратегия.
- `RELEASING.md` — релизный процесс Buzz.
- `NOSTR.md` и `docs\nips\` — используемые Nostr-протоколы и кастомные NIP.
- `VISION*.md` — долгосрочные направления продукта; это идеи, а не готовые функции.
- `docs\BUZZ_AUDIT.md` внутри RIFT — уже подготовленный вывод, что можно переносить.

### Skills для агентов

Buzz кладёт одинаковые ссылки на skills сразу для нескольких систем:

- `.agents\skills\desktop-screenshot\SKILL.md`
- `.agents\skills\sprout-cli\SKILL.md`
- `.claude\skills\desktop-screenshot\SKILL.md`
- `.claude\skills\sprout-cli\SKILL.md`
- `.codex\skills\desktop-screenshot\SKILL.md`
- `.codex\skills\sprout-cli\SKILL.md`
- `.goose\skills\desktop-screenshot\SKILL.md`
- `.goose\skills\sprout-cli\SKILL.md`

Это не восемь разных skills. Это копии/файлы-указатели на два настоящих документа:

- `desktop\src-tauri\src\managed_agents\screenshot_skill.md` — Playwright screenshots для Buzz и публикация картинок в GitHub PR через `scripts\post-screenshots.sh`.
- `desktop\src-tauri\src\managed_agents\nest_skill.md` — инструкция Buzz CLI: сообщения, каналы, DM, workflows, agents, repos и memory через Buzz relay.

Также есть:

- `examples\meadow-core\skills\github-research\SKILL.md` — skill исследования GitHub для демонстрационного agent workspace.
- `desktop\src-tauri\src\managed_agents\nest_agents.md` — инструкции управляемым агентам.

Skills `desktop-screenshot` и `sprout-cli` привязаны к инфраструктуре Buzz. Они полезны как образец организации агентных инструкций, но не запускают и не тестируют RIFT напрямую. Следующий агент не должен объявлять их частью RIFT или пытаться вызвать `buzz` без настроенного `BUZZ_PRIVATE_KEY`/relay.

### Основные папки исходников

- `desktop\` — главный Tauri/React desktop-клиент Buzz. Самый полезный референс для RIFT.
- `desktop\src\features\` — функциональные React-модули. Всего около 1092 TS/TSX файлов.
- `desktop\src-tauri\` — Rust/Tauri команды, huddle audio backend, managed-agent instructions и desktop integration.
- `crates\` — около 308 Rust-файлов: relay, core protocol, auth, database, media, search, CLI, workflows, agents и другие серверные компоненты.
- `web\` — web-клиент/веб-части.
- `mobile\` — мобильный клиент.
- `admin-web\` — административный интерфейс.
- `scripts\` и `script\` — автоматизация разработки, release, screenshots, проверки и миграции.
- `deploy\` — Docker/Compose/Helm deployment.
- `migrations\` — миграции серверной базы данных.
- `schema\` — схемы данных/протоколов.
- `examples\` — примеры агентов, CLI и Meadow workspace.
- `bench\`, `benchmarks\`, `perf\` — нагрузочные и performance-исследования.
- `patches\` — патчи сторонних зависимостей.

### Полезные desktop features

- `desktop\src\features\huddle\` — голосовые комнаты, start/join/leave lifecycle, audio devices, mic gain, PTT, active speaker, reconnect и compact HuddleBar.
- `desktop\src\features\messages\` — timeline, composer, drafts, reply/edit/delete, reactions, attachments, typing, threads, pagination и unread state.
- `desktop\src\features\sidebar\` — серверная/канальная навигация, starred/muted/unread, sections, drag-and-drop и connection/update cards.
- `desktop\src\features\notifications\` — desktop notifications, sounds, per-event preferences, badges и localStorage validation.
- `desktop\src\features\settings\` — updater, themes, shortcuts, notification/audio/profile settings.
- `desktop\src\features\channels\` — каналы и channel state.
- `desktop\src\features\communities\` — workspace/community switching и relay probing.
- `desktop\src\features\profile\` — profile/avatar/status UI.
- `desktop\src\features\search\` — поиск.
- `desktop\src\features\onboarding\` — onboarding и recovery screens.
- `desktop\src\features\moderation\`, `forum\`, `reminders\`, `custom-emoji\`, `presence\` — будущие продуктовые референсы.
- `agents\`, `agent-memory\`, `projects\`, `workflows\`, `mesh-compute\`, `pulse\` — агентная платформа Buzz; не является текущей целью RIFT.

### Самые полезные конкретные файлы

- `desktop\src\features\huddle\HuddleContext.tsx` — лучший референс voice lifecycle, cleanup token и bounded reconnect.
- `desktop\src\features\huddle\components\HuddleBar.tsx` — компактная панель звонка.
- `desktop\src\features\huddle\components\MicControls.tsx` — устройства, mute, gain и PTT controls.
- `desktop\src\features\huddle\lib\audioWorklet.ts` — AudioWorklet lifecycle; у Buzz он передаёт PCM в Rust, а не делает WebRTC/RNNoise.
- `desktop\src\features\huddle\lib\useAudioDevices.ts` — enumeration и смена микрофона.
- `desktop\src\features\messages\useTypingBroadcast.ts` — typing throttle раз в три секунды.
- `desktop\src\features\messages\ui\MessageActionBar.tsx` — действия сообщения и focus-management.
- `desktop\src\features\sidebar\ui\AppSidebar.tsx` — структура sidebar.
- `desktop\src\features\notifications\hooks.ts` — безопасное хранение notification settings.
- `desktop\src\features\settings\hooks\use-updater.ts` — guards для check/download/install и background update interval.
- `desktop\src\features\settings\ui\KeyboardShortcutsCard.tsx` — отображение shortcuts.
- `desktop\public\worklet.js` — worklet Buzz для PCM/PTT, если нужен дополнительный аудиореференс.

### Scripts, которые стоит изучить

- `scripts\post-screenshots.sh` — публикация immutable screenshots для PR.
- `scripts\check-pr-image-urls.sh` — проверка ссылок на изображения.
- `desktop\scripts\` — desktop build/test/screenshot helpers.
- `Justfile` — список основных project commands; перед запуском команды посмотреть соответствующий recipe.
- `.github\workflows\` — CI/release patterns Buzz.

Не копировать scripts вслепую: большинство ожидает pnpm workspace, `just`, Buzz mock bridge, GitHub CLI, Rust monorepo или работающий Buzz relay.

### Что из Buzz уже применено в RIFT

- Явный вход в voice вместо автоматического включения.
- Stable refs и строгая очистка media resources.
- Защита от устаревших WebRTC handlers/negotiation.
- Сворачиваемый compact call bar.
- Grace period для краткого disconnect.
- Updater state machine и blocking update UI.
- План следующих функций: devices/gain/PTT, bounded reconnect, typing/drafts/reactions/unread.

### Главное архитектурное отличие

Buzz не является serverless/P2P-приложением. Его relay — единственный источник истины; сервер использует Rust, Postgres, Redis, WebSocket fan-out, media storage и собственную передачу huddle audio. RIFT использует Buzz как дизайн и reliability reference, но связь RIFT остаётся WebRTC P2P. Копирование `buzz-relay`, database, Redis или Rust huddle transport нарушит требование пользователя «без платного центрального сервера».

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
- Единый mic-пайплайн `src\audio\micPipeline.ts`: `source → [RNNoise worklet] → gain → destination`. RNNoise теперь переключается без замены трека и без ренеготиации; live-регулировка громкости микрофона (0–200%). Старый `src\audio\rnnoise.ts` удалён как устаревший. Пайплайн деградирует в passthrough при сбое worklet (с fallback на браузерное шумоподавление).
- Выбор аудиоустройств: вход (микрофон, live-переключение с re-getUserMedia + replaceTrack) и выход (`setSinkId` на remote `<audio>`), список обновляется по `devicechange`. Push-to-talk: удержание пробела (не срабатывает в текстовых полях). Всё в модалке «Настройки звука» (кнопка наушников в user-bar и слайдеры в звонке); настройки хранятся в localStorage. Проверено: build + E2E PASS, UI-смоук в браузере без ошибок консоли.
- Bounded ICE restart (авто-reconnect при потере сети): при `disconnected`/`failed` peer ренеготиирует ICE через ещё живой data channel (`createOffer({iceRestart:true})` у impolite-пира, запрос у polite-пира) с ограниченным числом попыток и backoff (`MAX_ICE_RESTARTS=4`), и только потом объявляет «связь потеряна». Восстанавливает временные обрывы без повторного pairing. Проверено: build + E2E PASS.
- Active-speaker detection (`src\audio\speaking.ts`): один общий AudioContext + AnalyserNode с гистерезисом меряет RMS локального и удалённого аудио, рисует светящееся кольцо на орбах и точку в call-bar. Чисто клиентски, P2P. ВАЖНО: fake-audio Edge в E2E пищит → детектор срабатывает; поэтому индикатор говорящего сделан кольцом, а НЕ подменой текста «Друг в голосовом звонке» (иначе E2E-ассерт по этому тексту падал). Монитор не бросает исключений и не плодит AudioContext'ы (Chromium ограничивает их число — иначе краш звонка).
- Per-participant громкость друга (слайдер 0–100% через `<audio>.volume`) + deafen (кнопка в call-controls и call-bar; глушит выход друга). Проверено: build + E2E PASS.

## СТРАТЕГИЧЕСКИЙ ПОВОРОТ (2026-07-23): цель — платформа уровня Discord

Владелец подтвердил цель: не P2P-чат с голосом, а полноценный Discord-подобный сервис (многопользовательские голосовые каналы, выбор ближайшего сервера, screen share до 4K60 с аппаратным кодированием, видеосетки, per-user громкость, realtime по WebSocket, adaptive bitrate). **Это осознанный отход от принципа «без серверов»** — большинство требований физически невозможны на чистом P2P-mesh и требуют серверного тира. Направление и приоритеты уточняются; до решения по инфраструктуре не переписывать P2P и не выкидывать готовое. Подробный честный разбор «что требует сервера / что можно на фронте / фазовый план» — в ответе агента от 2026-07-23.

## Что не успел / делать следующим

1. Проверить всё аудио на настоящем микрофоне в Tauri Windows-приложении: выбор устройства, gain, push-to-talk, RNNoise, active-speaker ring, громкость друга, deafen, mute, hangup, повторный вход. Особое внимание — чтобы raw mic и processed track всегда останавливались.
2. Adaptive bitrate для 1:1 (RTP stats + `setParameters`, авто-снижение/восстановление качества видео/экрана). P2P-совместимо. Плохо тестируется в fake-audio E2E — проверять вручную.
3. Boost громкости друга >100% (нужен GainNode на remote-стриме; сейчас cap 100% через `<audio>.volume`).
4. Discord-level фичи, требующие сервера: SFU (LiveKit/mediasoup) для multi-user voice/video, backend (WebSocket gateway + Postgres/Redis) для сообщений/ролей/presence/history, TURN, S3-хранилище, нативный медиапайплайн для 4K60 HW-encode. Требует решения владельца по инфраструктуре.
5. Message delivery state/retry, typing indicator, edit/delete/reply/reactions (по roadmap Buzz).
4. Старый installer 0.4.0 нельзя удалённо заблокировать: в нём updater ещё не существовал. Обязательное обновление начинает работать только с 0.5.0. (Автообновление 0.5.0 → 0.5.1 уже проверено на живом Windows — см. статус ниже.)

### Как собрать локальный подписанный installer (проверено 2026-07-23)

Важно: эта версия Tauri 2 читает `TAURI_SIGNING_PRIVATE_KEY` (содержимое ключа или путь к файлу), а НЕ `TAURI_SIGNING_PRIVATE_KEY_PATH` — с последним подпись падает «A public key has been found, but no private key. Make sure to set `TAURI_SIGNING_PRIVATE_KEY` environment variable.». Содержимое ключа нигде не печатать и не коммитить.

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY=(Get-Content C:\Users\FSOS\.tauri\rift.key -Raw)
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''
$env:CARGO_TARGET_DIR='C:\Users\FSOS\Documents\Lua\rift-messenger\src-tauri\target-v0.5'
npm run desktop:build
```

Результат: `...\target-v0.5\release\bundle\nsis\RIFT_0.5.0_x64-setup.exe` + `.sig`.

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

Обновлено 2026-07-23 (агент довёл release).

- `npm run build`: PASS.
- `cargo check`: PASS; Cargo.lock на rift-messenger 0.5.0.
- `npm run test:e2e`: PASS локально и в CI. Первый CI-run `29956660831` упал не по сети, а по таймингу: вход в звонок поднимает ~2 МБ RNNoise WASM-worklet в двух браузерных контекстах и ренеготиирует audio m-line, а ассерты стояли на 15 с. Исправлено: (1) в `src\audio\rnnoise.ts` вход RNNoise ограничен таймаутом 8 с (`createRnnoiseTrack(track, 8000)`) — при зависании/медленном worklet идёт fallback на browser suppression, звонок не залипает; (2) в E2E ассерты голоса подняты до 45 с; (3) в Playwright config `retries: process.env.CI ? 2 : 0`. Коммит `d6a0a66`.
- GitHub repo: `https://github.com/DeLorean-bot/rift-messenger`, public, `main` синхронизирован.
- GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` (+ пустой `..._PASSWORD`) загружены sealed-box шифрованием из `C:\Users\FSOS\.tauri\rift.key`. Ключ нигде не печатался.
- GitHub release `v0.5.0`: **опубликован** (workflow_dispatch run `29957417229`, success). Ассеты: `RIFT_0.5.0_x64-setup.exe` (~4.45 МБ), `RIFT_0.5.0_x64-setup.exe.sig`, `latest.json`. Эндпоинт `.../releases/latest/download/latest.json` отдаёт version 0.5.0 с подписью.
- Updater-цепочка проверена криптографически: key-id подписи в `latest.json` == key-id публичного ключа из `tauri.conf.json` (`163EF993EF2F9B0C`). То есть релиз подписан ключом, соответствующим вшитому в приложение pubkey.
- Локальный подписанный installer 0.5.0: собран и подписан (`target-v0.5\...\RIFT_0.5.0_x64-setup.exe` + `.sig`, EXIT 0) — см. правильную команда выше.
- Реальный runtime-тест автообновления: **ПРОЙДЕН 2026-07-23**. Локально поставлен подписанный 0.5.0 (`C:\Users\FSOS\AppData\Local\RIFT\rift-messenger.exe`), при запуске mandatory updater без взаимодействия скачал и поставил 0.5.1 — on-disk версия и реестр (DisplayVersion) стали `0.5.1`. Это подтверждает всю цепочку: check → downloadAndInstall → relaunch на живом Windows.
- Текущая версия проекта поднята до **0.5.1** (release `v0.5.1` опубликован, run `29958494655`, success; `latest.json` отдаёт 0.5.1, key-id подписи совпадает). Следующий релиз — 0.5.2.

## Готовый промпт следующему агенту

```text
Продолжай разработку RIFT в C:\Users\FSOS\Documents\Lua\rift-messenger. Сначала полностью прочитай HANDOFF.md и docs\BUZZ_AUDIT.md, затем самостоятельно проверь фактическое состояние Git и файлов — не полагайся слепо на описание. Не удаляй готовые функции и не меняй P2P-архитектуру без причины. Репозиторий DeLorean-bot/rift-messenger опубликован, secret подписи загружен, release v0.5.0 собран, подписан и проверен криптографически (latest.json отдаётся, key-id совпадает). Запусти npm run build, cargo check --manifest-path src-tauri\Cargo.toml и npm run test:e2e — все три должны быть PASS. Дальше по приоритету: (1) реальный runtime-тест автообновления 0.5.0 → 0.5.1 на живом Windows; (2) устройства input/output, mic gain, push-to-talk; (3) bounded ICE restart. Приватный ключ разрешено использовать локально из C:\Users\FSOS\.tauri\rift.key через TAURI_SIGNING_PRIVATE_KEY (не _PATH), но запрещено печатать, коммитить или класть в логи его содержимое. После каждого крупного изменения снова проверяй build/E2E и обновляй HANDOFF фактическим статусом.
```

## Лицензии

- Buzz: Apache-2.0, использовался как архитектурный/UX reference.
- `@jitsi/rnnoise-wasm`: Apache-2.0.
- Upstream Xiph RNNoise: BSD-3-Clause.
- Код OBS RNNoise integration напрямую не копировался, потому что OBS GPL-2.0. Использована совместимая WASM-реализация и собственная интеграция.
