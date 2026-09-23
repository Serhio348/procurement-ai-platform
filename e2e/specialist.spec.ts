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

/**
 * Full specialist round-trip against the real API + persistence (R41):
 * sign in → name the profile and give it a keyword → run the profile search
 * → a review candidate lands in the inbox → open its card → decide →
 * reload the browser — the decision must survive, because it lives in the
 * server-side store, not the page (regression coverage for R01/R03/R27).
 *
 * The fixture source scores through the cheap scorer, so uncertain hits
 * arrive as inbox review rows — the same path a live run takes when the
 * classifier is unsure.
 */
test("specialist flow: login → profile → search → review → decide → survives reload", async ({
  page,
}) => {
  await signIn(page);

  // Name the default profile and give it a keyword the fixture hits match.
  await page.getByRole("link", { name: "Профили" }).click();
  await page.locator(".profile-list-link").first().click();
  await page.locator("#profile-name").fill("КТП e2e");
  await page.getByLabel("Добавить слово").fill("КТП");
  await page.getByRole("button", { name: "Добавить" }).click();
  await page.getByRole("button", { name: "Сохранить профиль" }).click();
  await expect(page.locator(".profile-list-link")).toContainText("КТП e2e");

  // Run the profile search on the fixture source; unscored candidates land
  // in the inbox as review rows.
  await page.getByRole("link", { name: "Закупки", exact: true }).click();
  await page.getByRole("button", { name: "Искать по профилю" }).click();
  await page.getByRole("link", { name: "Входящие" }).click();
  const candidate = page
    .locator(".inbox-list .inbox-title")
    .filter({ hasText: /КТП|подстанц|трансформатор|кабель/i });
  await expect(candidate.first()).toBeVisible({ timeout: 60_000 });

  // Open the candidate's card and mark it watched.
  await candidate.first().click();
  await page.getByRole("button", { name: "Открыть карточку" }).click();
  await page.getByRole("button", { name: "Отслеживать" }).click();

  // The decision lands in «Мои закупки» and survives a browser reload —
  // the queue/decision live in PostgreSQL (CI) or the durable store, not
  // in the page.
  await page.getByRole("link", { name: "Мои закупки" }).click();
  await expect(page.locator("main")).toContainText(/КТП|подстанц|трансформатор|кабель/i, {
    timeout: 30_000,
  });
  await page.reload();
  await page.getByRole("link", { name: "Мои закупки" }).click();
  await expect(page.locator("main")).toContainText(/КТП|подстанц|трансформатор|кабель/i, {
    timeout: 30_000,
  });
});
