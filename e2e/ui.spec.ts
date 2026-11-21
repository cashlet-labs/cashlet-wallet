import type { Page } from "@playwright/test";
import { expect, test, VECTOR } from "./fixtures";

const PASSWORD = "e2e password";

async function setPassword(page: Page) {
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Repeat the password").fill(PASSWORD);
}

async function importVector(page: Page) {
  await page.getByRole("button", { name: "I already have a recovery phrase" }).click();
  // Pasting the whole phrase into any box fills all twelve.
  await page.getByLabel("Word 5", { exact: true }).focus();
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text", text);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, VECTOR);
  await setPassword(page);
  await page.getByRole("button", { name: "Restore wallet" }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
}

test("creating a wallet shows the phrase once and checks the backup", async ({ popup }) => {
  await popup.getByRole("button", { name: "Create a new wallet" }).click();
  await setPassword(popup);
  await popup.getByRole("button", { name: "Continue" }).click();

  const phrase = popup.getByRole("list", { name: "Your recovery phrase" });
  await expect(phrase.locator(".static")).toHaveCount(12);
  const words = await phrase.locator(".static").allTextContents();
  const next = popup.getByRole("button", { name: "Continue" });
  await expect(next).toBeDisabled();
  await popup.getByLabel("I wrote the words down, in order").check();
  await next.click();

  // Three positions are asked; a wrong word keeps Finish disabled.
  const questions = popup.locator("label").filter({ hasText: /^Word \d+$/ });
  await expect(questions).toHaveCount(3);
  const finish = popup.getByRole("button", { name: "Finish" });
  await questions.first().locator("input").fill("zoo");
  await expect(finish).toBeDisabled();
  for (const question of await questions.all()) {
    const position = Number((await question.textContent())?.replace(/\D/g, ""));
    await question.locator("input").fill(words[position - 1] ?? "");
  }
  await expect(finish).toBeEnabled();
  await finish.click();
  await expect(popup.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(popup.getByText("not backed up yet")).toHaveCount(0);
});

test("the phrase boxes autocomplete words and catch mistakes", async ({ popup }) => {
  await popup.getByRole("button", { name: "I already have a recovery phrase" }).click();
  await expect(popup.getByRole("combobox", { name: /^Word \d+$/ })).toHaveCount(12);

  const first = popup.getByLabel("Word 1", { exact: true });
  await first.pressSequentially("aba");
  await expect(popup.getByRole("listbox").getByRole("option", { name: "abandon" })).toBeVisible();
  await first.press("Tab");
  await expect(first).toHaveValue("abandon");
  await expect(popup.getByLabel("Word 2", { exact: true })).toBeFocused();

  // A word still being typed is not reported as unknown.
  await expect(popup.getByText(/not on the recovery word list/)).toHaveCount(0);

  // An ambiguous prefix is not completed.
  await popup.getByLabel("Word 2", { exact: true }).pressSequentially("ab");
  await expect(popup.getByRole("listbox").getByRole("option")).toHaveCount(4);
  await popup.getByRole("listbox").getByRole("option", { name: "about" }).click();
  await expect(popup.getByLabel("Word 2", { exact: true })).toHaveValue("about");

  // A word that is not on the list is flagged.
  await popup.getByLabel("Word 3", { exact: true }).fill("bitcoin");
  await popup.getByLabel("Word 4", { exact: true }).focus();
  await expect(popup.getByText("Word 3 is not on the recovery word list.")).toBeVisible();

  // Twelve valid words with a wrong checksum.
  for (let i = 1; i <= 12; i++)
    await popup.getByLabel(`Word ${i}`, { exact: true }).fill("abandon");
  await expect(popup.getByText("These words are not a valid recovery phrase.")).toBeVisible();
  await popup.getByLabel("Word 12", { exact: true }).fill("about");
  await expect(popup.getByText("The recovery phrase is valid.")).toBeVisible();

  await popup.getByLabel("Number of words").selectOption("24");
  await expect(popup.getByRole("combobox", { name: /^Word \d+$/ })).toHaveCount(24);
});

test("restores from a pasted phrase, locks and unlocks", async ({ popup }) => {
  await importVector(popup);
  await popup.getByRole("button", { name: "Lock" }).click();
  await expect(popup.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await popup.getByLabel("Password").fill("not the password");
  await popup.getByRole("button", { name: "Unlock" }).click();
  await expect(popup.getByRole("alert")).toHaveText("That password is not right.");
  await popup.getByLabel("Password").fill(PASSWORD);
  await popup.getByRole("button", { name: "Unlock" }).click();
  await expect(popup.getByRole("button", { name: "Send", exact: true })).toBeVisible();
});

test("receive shows the next address, and a token address on request", async ({ popup }) => {
  await importVector(popup);
  await popup.getByRole("button", { name: "Receive" }).click();
  const address = popup.getByTestId("receive-address");
  await expect(address).toHaveText(/^bchtest:q/);
  await expect(popup.getByRole("img", { name: /QR code for bchtest:/ })).toBeVisible();
  await popup.getByRole("tab", { name: "BCH and tokens" }).click();
  await expect(address).toHaveText(/^bchtest:z/);
  await popup.getByLabel("Amount to request (optional)").fill("0.1.2");
  await expect(popup.getByText(/at most 8 decimals/)).toBeVisible();
});

test("send explains a missing balance and refuses another network's address", async ({ popup }) => {
  await importVector(popup);
  await popup.getByRole("button", { name: "Send", exact: true }).click();
  await popup.getByLabel("To").fill("bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6");
  await popup.getByLabel("Amount (BCH)").fill("0.001");
  await popup.getByRole("button", { name: "Review" }).click();
  await expect(popup.getByRole("alert")).toContainText(/mainnet address|not a valid/);
  await popup.getByLabel("To").fill("bchtest:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnqseeszx8x");
  await popup.getByRole("button", { name: "Review" }).click();
  await expect(popup.getByRole("alert")).toContainText("Not enough BCH");
});

test("settings: the phrase needs the password, and contacts are checked", async ({ popup }) => {
  await importVector(popup);
  await popup.getByRole("button", { name: "Settings" }).click();
  await popup.getByRole("button", { name: "Show recovery phrase" }).click();
  await popup.getByLabel("Password").fill("not the password");
  await popup.getByRole("button", { name: "Show" }).click();
  await expect(popup.getByRole("alert")).toHaveText("That password is not right.");
  await popup.getByLabel("Password").fill(PASSWORD);
  await popup.getByRole("button", { name: "Show" }).click();
  await expect(popup.locator(".static")).toHaveText(VECTOR.split(" "));

  await popup.getByRole("button", { name: "Back" }).click();
  await popup.getByRole("button", { name: "Address book" }).click();
  await popup.getByLabel("Name").fill("Ann");
  await popup.getByLabel("Address").fill("bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6");
  await popup.getByRole("button", { name: "Save" }).click();
  await expect(popup.getByRole("alert")).toBeVisible();
  await popup.getByLabel("Address").fill("bchtest:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnqseeszx8x");
  await popup.getByRole("button", { name: "Save" }).click();
  await expect(popup.getByText("Ann")).toBeVisible();
});

// Reads the real relays but never publishes: the test vector's identity is shared by everyone.
test("identity shows the wallet's Nostr key and the address it names", async ({ popup }) => {
  await importVector(popup);
  await popup.getByRole("button", { name: "Identity" }).click();
  await expect(popup.getByRole("heading", { name: "Identity" })).toBeVisible();
  await expect(popup.getByTestId("npub")).toHaveText(/^npub1[02-9ac-hj-np-z]{58}$/, {
    timeout: 30_000,
  });
  await expect(popup.getByTestId("identity-address")).toHaveText(/^bchtest:q/);
  await expect(popup.getByTestId("identity-state")).not.toBeEmpty();
  await expect(popup.getByLabel(/Also publish to public Nostr relays/)).toBeChecked();
});

test("a site gets the Nostr key and a signature only after the user approves", async ({
  context,
  popup,
}) => {
  await importVector(popup);
  await context.route("https://app.example/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>App</title>" }),
  );
  const site = await context.newPage();
  await site.goto("https://app.example/");
  expect(await site.evaluate(() => typeof (window as { nostr?: unknown }).nostr)).toBe("object");

  // getPublicKey opens the approval window.
  const approval = context.waitForEvent("page");
  const key = site.evaluate(() =>
    (window as unknown as { nostr: { getPublicKey(): Promise<string> } }).nostr.getPublicKey(),
  );
  const window1 = await approval;
  await expect(window1.getByTestId("approval-origin")).toHaveText("https://app.example");
  await window1.getByRole("button", { name: "Connect" }).click();
  expect(await key).toMatch(/^[0-9a-f]{64}$/);

  // Each answered request closes the window; the next request opens a new one.
  await window1.waitForEvent("close");
  const approval2 = context.waitForEvent("page");
  const signing = site.evaluate(() =>
    (
      window as unknown as { nostr: { signEvent(e: unknown): Promise<{ sig: string }> } }
    ).nostr.signEvent({ kind: 1, content: "hello from e2e", tags: [], created_at: 1_795_200_000 }),
  );
  const window2 = await approval2;
  await expect(window2.getByTestId("event-content")).toHaveText("hello from e2e");
  await window2.getByRole("button", { name: "Sign" }).click();
  expect((await signing).sig).toMatch(/^[0-9a-f]{128}$/);

  // A rejection reaches the page as an error.
  await window2.waitForEvent("close");
  const approval3 = context.waitForEvent("page");
  const rejected = site.evaluate(() =>
    (window as unknown as { nostr: { signEvent(e: unknown): Promise<unknown> } }).nostr
      .signEvent({ kind: 1, content: "no", tags: [], created_at: 1_795_200_000 })
      .then(
        () => "signed",
        (e: Error) => e.message,
      ),
  );
  const window3 = await approval3;
  await window3.getByRole("button", { name: "Reject" }).click();
  expect(await rejected).toBe("the user rejected the request");
});
