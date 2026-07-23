import { expect, test } from '@playwright/test';

test('two clients connect by link and receive each other audio', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const prepare = async (page: Awaited<ReturnType<typeof hostContext.newPage>>) => {
    await page.addInitScript(() => {
      localStorage.setItem('rift.onboardingOpen', 'false');
    });
    await page.goto('/');
  };

  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  await Promise.all([prepare(host), prepare(guest)]);

  await host.getByRole('button', { name: /Подключить друга/ }).click();
  await host.getByRole('button', { name: /Создать ссылку для друга/ }).click();
  const invitation = await host.locator('.share-link-box input').inputValue({ timeout: 20_000 });
  expect(invitation).toMatch(/^rift:\/\/join\//);

  await guest.getByRole('button', { name: /Подключить друга/ }).click();
  await guest.getByPlaceholder('rift://join/…').fill(invitation);
  await guest.getByRole('button', { name: 'Подключиться', exact: true }).click();

  await expect(host.locator('.connection-card strong')).toHaveText('прямое соединение', { timeout: 20_000 });
  await expect(guest.locator('.connection-card strong')).toHaveText('прямое соединение', { timeout: 20_000 });
  await expect(host.locator('.call-stage')).toHaveCount(0);
  await expect(guest.locator('.call-stage')).toHaveCount(0);

  await host.waitForTimeout(8_500);
  await expect(host.locator('.connection-card strong')).toHaveText('прямое соединение');
  await expect(guest.locator('.connection-card strong')).toHaveText('прямое соединение');

  await Promise.all([
    host.getByTitle('Войти в звонок').click(),
    guest.getByTitle('Войти в звонок').click(),
  ]);
  // Entering a call spins up RNNoise (a ~2 MB WASM AudioWorklet) in both
  // contexts and then renegotiates the audio m-line. On a shared CI runner
  // that whole path is much slower than on a dev box, so allow generous headroom.
  await expect(host.getByText('Друг в голосовом звонке')).toBeVisible({ timeout: 45_000 });
  await expect(guest.getByText('Друг в голосовом звонке')).toBeVisible({ timeout: 45_000 });
  await expect.poll(() => host.locator('audio').evaluate((element) => {
    const track = (element as HTMLAudioElement).srcObject instanceof MediaStream
      ? ((element as HTMLAudioElement).srcObject as MediaStream).getAudioTracks()[0]
      : undefined;
    return Boolean(track && track.readyState === 'live' && !track.muted);
  }), { timeout: 45_000 }).toBe(true);
  await host.getByTitle('Свернуть звонок').click();
  await expect(host.locator('.call-bar')).toBeVisible();
  await expect(host.locator('.call-stage')).toHaveCount(0);

  // Text pillar: typing indicator, delivery receipt, reactions over the data channel.
  const hostComposer = host.getByPlaceholder(/Сообщение в #/);
  await hostComposer.fill('привет это тест');
  await expect(guest.getByText('Собеседник печатает…')).toBeVisible({ timeout: 10_000 });
  await hostComposer.press('Enter');
  await expect(guest.getByText('привет это тест')).toBeVisible({ timeout: 10_000 });
  await expect(host.locator('.msg-status')).toBeVisible({ timeout: 10_000 });

  await guest.getByText('привет это тест').hover();
  await guest.locator('.msg-action.emoji').first().click();
  await expect(host.locator('.reaction-chip')).toBeVisible({ timeout: 10_000 });

  await hostContext.close();
  await guestContext.close();
});
