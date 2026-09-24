import { expect, test, type Page } from "@playwright/test";

const EMAIL = process.env["E2E_ADMIN_EMAIL"] ?? "e2e-admin@test.local";
const PASSWORD = process.env["E2E_ADMIN_PASSWORD"] ?? "e2e-admin-password";

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("link", { name: "Закупки", exact: true })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "horizontal overflow").toBeLessThanOrEqual(1);
}

/**
 * R32: narrow-viewport layout — the shell must fit without horizontal
 * scrolling, the nav must collapse into a top strip, and on the two-pane
 * workspace the opened card must render above the list (single-panel
 * list↔detail pattern that a future PWA shell reuses).
 */
for (const width of [320, 390, 768]) {
  test(`responsive shell at ${width}px: no horizontal overflow, nav visible`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    await expectNoHorizontalOverflow(page);

    // The nav is a horizontal strip on top, not a 220px side column.
    const nav = page.locator(".nav");
    const navBox = await nav.boundingBox();
    expect(navBox).not.toBeNull();
    expect(navBox!.height).toBeLessThanOrEqual(90);
    await expect(page.getByRole("link", { name: "Входящие" })).toBeVisible();

    for (const section of ["Закупки", "Мои закупки", "Профили"]) {
      await page.getByRole("link", { name: section, exact: section === "Закупки" }).click();
      await expectNoHorizontalOverflow(page);
    }
  });
}

test("responsive workspace at 390px: opened card renders above the list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signIn(page);

  // Seed a review candidate via the fixture search (same setup as the
  // specialist flow).
  await page.getByRole("link", { name: "Профили" }).click();
  await page.locator(".profile-list-link").first().click();
  await page.locator("#profile-name").fill("КТП mobile");
  await page.getByLabel("Добавить слово").fill("КТП");
  await page.getByRole("button", { name: "Добавить" }).click();
  await page.getByRole("button", { name: "Сохранить профиль" }).click();

  await page.getByRole("link", { name: "Закупки", exact: true }).click();
  await page.getByRole("button", { name: "Искать по профилю" }).click();
  await page.getByRole("link", { name: "Входящие" }).click();
  const candidate = page
    .locator(".inbox-list .inbox-title")
    .filter({ hasText: /КТП|подстанц|трансформатор|кабель/i });
  await expect(candidate.first()).toBeVisible({ timeout: 60_000 });
  await expectNoHorizontalOverflow(page);

  // Open the entry — on a narrow screen the card is the primary panel and
  // renders above the list; the action buttons stay reachable.
  await candidate.first().click();
  const detail = page.locator(".detail");
  await expect(detail).toBeVisible();
  const inbox = page.locator(".inbox");
  const [detailBox, inboxBox] = await Promise.all([
    detail.boundingBox(),
    inbox.boundingBox(),
  ]);
  expect(detailBox).not.toBeNull();
  expect(inboxBox).not.toBeNull();
  expect(detailBox!.y).toBeLessThan(inboxBox!.y);
  await expectNoHorizontalOverflow(page);

  // Touch targets: opened-card actions are at least 44px tall.
  const action = detail.getByRole("button").first();
  await expect(action).toBeVisible();
  const actionBox = await action.boundingBox();
  expect(actionBox!.height).toBeGreaterThanOrEqual(44);
});
