import type { Page } from "@playwright/test";
import { expect, test, VECTOR } from "./fixtures";

const PASSWORD = "e2e password";
// The x coordinate of the secp256k1 generator, a valid public key.
const PEER = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

async function importVector(page: Page) {
  await page.getByRole("button", { name: "I already have a recovery phrase" }).click();
  await page.getByLabel("Word 5", { exact: true }).focus();
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text", text);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, VECTOR);
  await page.getByText("Developer options").click();
  await page.getByLabel("Use chipnet, the test network").check();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Repeat the password").fill(PASSWORD);
  await page.getByRole("button", { name: "Restore wallet" }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
}

type Nostr = {
  getPublicKey(): Promise<string>;
  nip04: {
    encrypt(k: string, t: string): Promise<string>;
    decrypt(k: string, t: string): Promise<string>;
  };
  nip44: {
    encrypt(k: string, t: string): Promise<string>;
    decrypt(k: string, t: string): Promise<string>;
  };
};

test("a connected site encrypts and decrypts after each approval", async ({ context, popup }) => {
  await importVector(popup);
  await context.route("https://app.example/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>App</title>" }),
  );
  const site = await context.newPage();
  await site.goto("https://app.example/");

  // Not connected yet: refused without a window.
  const early = await site.evaluate(() =>
    (window as unknown as { nostr: Nostr }).nostr.nip44
      .encrypt("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "hi")
      .then(
        () => "encrypted",
        (e: Error) => e.message,
      ),
  );
  expect(early).toContain("not connected");

  const connecting = context.waitForEvent("page");
  void site.evaluate(() => (window as unknown as { nostr: Nostr }).nostr.getPublicKey());
  const connectWindow = await connecting;
  await connectWindow.getByRole("button", { name: "Connect" }).click();
  await connectWindow.waitForEvent("close");

  for (const scheme of ["nip04", "nip44"] as const) {
    const askEncrypt = context.waitForEvent("page");
    const sealed = site.evaluate(
      ([s, key]) =>
        (window as unknown as { nostr: Nostr }).nostr[s as "nip04" | "nip44"].encrypt(
          key as string,
          "meet at noon",
        ),
      [scheme, PEER],
    );
    const encryptWindow = await askEncrypt;
    await expect(encryptWindow.getByTestId("cipher-peer")).toHaveText(/^npub1/);
    await expect(encryptWindow.getByTestId("cipher-plaintext")).toHaveText("meet at noon");
    await encryptWindow.getByRole("button", { name: "Encrypt" }).click();
    const ciphertext = await sealed;
    expect(ciphertext).not.toContain("meet");
    await encryptWindow.waitForEvent("close");

    const askDecrypt = context.waitForEvent("page");
    const opened = site.evaluate(
      ([s, key, text]) =>
        (window as unknown as { nostr: Nostr }).nostr[s as "nip04" | "nip44"].decrypt(
          key as string,
          text as string,
        ),
      [scheme, PEER, ciphertext],
    );
    const decryptWindow = await askDecrypt;
    await expect(decryptWindow.getByTestId("cipher-plaintext")).toHaveCount(0);
    await decryptWindow.getByRole("button", { name: "Decrypt" }).click();
    expect(await opened).toBe("meet at noon");
    await decryptWindow.waitForEvent("close");
  }
});

test("Settings signs a message and verifies it", async ({ popup }) => {
  await importVector(popup);
  await popup.getByRole("button", { name: "Settings" }).click();
  await popup.getByRole("button", { name: "Sign a message" }).click();
  await popup.getByLabel("Message").fill("I own this address");
  await popup.getByRole("button", { name: "Sign", exact: true }).click();
  const address = (await popup.getByTestId("signed-address").textContent()) ?? "";
  const signature = (await popup.getByTestId("signature").textContent()) ?? "";
  expect(address).toMatch(/^bchtest:q/);
  expect(signature).toMatch(/^[A-Za-z0-9+/]{87}=$/);

  await popup.getByRole("button", { name: "Back" }).click();
  await popup.getByRole("button", { name: "Verify a message" }).click();
  await popup.getByLabel("Address").fill(address);
  await popup.getByLabel("Message").fill("I own this address");
  await popup.getByLabel("Signature").fill(signature);
  await popup.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(popup.getByTestId("verify-result")).toContainText("Valid");

  await popup.getByLabel("Message").fill("something else");
  await popup.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(popup.getByTestId("verify-result")).toContainText("Not valid");
});
