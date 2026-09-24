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
 * R32: narrow-viewport layout — hybrid mobile navigation (top bar +
 * bottom tab bar + slide-in drawer, the WB/Ozon/Gmail pattern) and a
 * single-panel list↔detail workspace that a future PWA shell reuses.
 */
for (const width of [320, 390, 768]) {
  test(`responsive shell at ${width}px: no overflow, bottom tabs visible`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    await expectNoHorizontalOverflow(page);

    // Bottom tab bar is present with the primary sections + «Ещё».
    const tabs = page.locator(".mobile-tabs");
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole("link", { name: /Входящие/ })).toBeVisible();
    await expect(tabs.getByRole("link", { name: /Закупки/ })).toBeVisible();
    await expect(tabs.getByRole("link", { name: /Мои/ })).toBeVisible();
    await expect(tabs.getByRole("link", { name: /Профили/ })).toBeVisible();
    await expect(tabs.getByRole("button", { name: /Ещё/ })).toBeVisible();

    // The drawer stays off-canvas until opened.
    await expect(page.locator(".shell")).not.toHaveClass(/is-nav-open/);

    for (const section of ["Закупки", "Мои", "Профили"]) {
      await tabs.getByRole("link", { name: new RegExp(section) }).click();
      await expectNoHorizontalOverflow(page);
    }
  });
}

test("responsive drawer at 390px: opens via «Ещё», closes via ✕ and backdrop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signIn(page);

  // «Ещё» in the tab bar opens the drawer with the full section list.
  await page.locator(".mobile-tabs").getByRole("button", { name: /Ещё/ }).click();
  const nav = page.locator(".nav");
  await expect(nav.getByRole("link", { name: "Корзина" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Выйти" })).toBeVisible();
  await expect(page.locator(".shell")).toHaveClass(/is-nav-open/);

  // ✕ closes the drawer.
  await nav.getByRole("button", { name: "Закрыть меню" }).click();
  await expect(page.locator(".shell")).not.toHaveClass(/is-nav-open/);

  // Hamburger in the top bar opens it; backdrop click closes it.
  await page.getByRole("button", { name: "Меню", exact: true }).click();
  await expect(nav.getByRole("link", { name: "Корзина" })).toBeVisible();
  await page.locator(".nav-backdrop").click({ position: { x: 340, y: 400 } });
  await expect(page.locator(".shell")).not.toHaveClass(/is-nav-open/);

  // Escape also closes it.
  await page.getByRole("button", { name: "Меню", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".shell")).not.toHaveClass(/is-nav-open/);

  // Choosing a section navigates and auto-closes the drawer.
  await page.getByRole("button", { name: "Меню", exact: true }).click();
  await nav.getByRole("link", { name: "Корзина" }).click();
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator(".shell")).not.toHaveClass(/is-nav-open/);
});

test("responsive workspace at 390px: opened card renders above the list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signIn(page);

  // Seed a review candidate via the fixture search (same setup as the
  // specialist flow).
  await page.locator(".mobile-tabs").getByRole("link", { name: /Профили/ }).click();
  await page.locator(".profile-list-link").first().click();
  await page.locator("#profile-name").fill("КТП mobile");
  await page.getByLabel("Добавить слово").fill("КТП");
  await page.getByRole("button", { name: "Добавить" }).click();
  await page.getByRole("button", { name: "Сохранить профиль" }).click();

  await page.locator(".mobile-tabs").getByRole("link", { name: /Закупки/ }).click();
  await page.getByRole("button", { name: "Искать по профилю" }).click();
  await page.locator(".mobile-tabs").getByRole("link", { name: /Входящие/ }).click();
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
