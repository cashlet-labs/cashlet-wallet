// Takes the README screenshots into docs/. Skipped unless SCREENSHOTS=1:
//   npm run build && SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts
import type { Page } from "@playwright/test";
import { expect, test, VECTOR } from "./fixtures";

test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to take the README screenshots");

const PASSWORD = "screenshot password";

async function restore(page: Page) {
  await page.setViewportSize({ width: 380, height: 600 });
  await page.getByRole("button", { name: "I already have a recovery phrase" }).click();
  await page.getByLabel("Word 5", { exact: true }).focus();
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text", text);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, VECTOR);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Repeat the password").fill(PASSWORD);
  await page.getByRole("button", { name: "Restore wallet" }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
}

const shot = (page: Page, name: string) => page.screenshot({ path: `docs/screenshot-${name}.png` });

test("screenshots", async ({ context, popup }) => {
  test.setTimeout(90_000);
  await restore(popup);
  await popup.waitForTimeout(3000);
  await shot(popup, "home");

  await popup.getByRole("button", { name: "Receive" }).click();
  await expect(popup.getByRole("img", { name: /QR code for bchtest:/ })).toBeVisible();
  await shot(popup, "receive");
  await popup.getByRole("button", { name: "Back" }).click();

  await popup.getByRole("button", { name: "Identity" }).click();
  await expect(popup.getByTestId("npub")).toHaveText(/^npub1/, { timeout: 30_000 });
  await popup.waitForTimeout(3000);
  await shot(popup, "identity");
  await popup.getByRole("button", { name: "Back" }).click();

  await popup.getByRole("button", { name: "Send", exact: true }).click();
  await popup.getByLabel("To", { exact: true }).fill("did:bnd:chipnet:");
  await shot(popup, "send");
  await popup.getByRole("button", { name: "Back" }).click();

  await popup.getByRole("button", { name: "Apps" }).click();
  await shot(popup, "apps");
  await popup.getByRole("button", { name: "Back" }).click();

  await context.route("https://app.example/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>App</title>" }),
  );
  const site = await context.newPage();
  await site.goto("https://app.example/");
  const approval = context.waitForEvent("page");
  site
    .evaluate(() =>
      (window as unknown as { nostr: { getPublicKey(): Promise<string> } }).nostr.getPublicKey(),
    )
    .catch(() => undefined);
  const window1 = await approval;
  await window1.setViewportSize({ width: 380, height: 600 });
  await expect(window1.getByTestId("approval-origin")).toHaveText("https://app.example");
  await shot(window1, "approval");
});
