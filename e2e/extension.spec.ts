import { expect, test } from "./fixtures";

test("the service worker starts and the popup reaches it", async ({ popup }) => {
  const errors: string[] = [];
  popup.on("pageerror", (error) => errors.push(error.message));
  await popup.reload();
  await expect(popup.getByRole("heading", { name: "Your keys, your Bitcoin Cash" })).toBeVisible();
  expect(await popup.evaluate(() => chrome.runtime.sendMessage({ type: "PING" }))).toEqual({
    ok: true,
    bindingKind: 30078,
  });
  expect(errors).toEqual([]);
});

test("the service worker refuses malformed and unknown messages", async ({ popup }) => {
  const reply = (message: unknown) =>
    popup.evaluate((m) => chrome.runtime.sendMessage(m), message as object);
  expect(await reply({ type: "NOPE" })).toEqual({ ok: false, error: "unknown message type: NOPE" });
  expect(await reply({ type: "PING", extra: 1 })).toEqual({ ok: false, error: "malformed PING" });
  expect(await reply({ type: "VERIFY_BINDING", event: { kind: 1 } })).toEqual({
    ok: false,
    reason: "not a Nostr event",
  });
});

test("a web page cannot reach the service worker", async ({ context }) => {
  const page = await context.newPage();
  await page.goto("data:text/html,<p>hello</p>");
  // There are no content scripts and no externally_connectable, so the page has no channel at all.
  const channel = await page.evaluate(() => {
    const api = (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome;
    return typeof api?.runtime?.sendMessage;
  });
  expect(channel).toBe("undefined");
});

test("creates, locks and unlocks a wallet, and stores no recovery phrase in the clear", async ({
  popup,
}) => {
  const send = (message: object) => popup.evaluate((m) => chrome.runtime.sendMessage(m), message);

  const created = (await send({
    type: "CREATE_WALLET",
    password: "e2e password",
    network: "chipnet",
  })) as {
    ok: boolean;
    mnemonic: string;
  };
  expect(created.ok).toBe(true);
  expect(created.mnemonic.split(" ")).toHaveLength(12);

  const stored = JSON.stringify(await popup.evaluate(() => chrome.storage.local.get(null)));
  expect(stored).toContain('"kdf":"PBKDF2-SHA256"');
  expect(stored).not.toContain(created.mnemonic.split(" ").slice(0, 3).join(" "));
  expect(stored).not.toContain("e2e password");

  const address = (await send({ type: "GET_RECEIVE_ADDRESS", tokenAware: false })) as {
    address: string;
  };
  expect(address.address).toMatch(/^bchtest:q/);

  expect(await send({ type: "LOCK" })).toEqual({ ok: true });
  expect(await send({ type: "GET_BALANCE" })).toMatchObject({ ok: false, code: "LOCKED" });
  expect(await send({ type: "UNLOCK", password: "wrong password" })).toMatchObject({
    code: "WRONG_PASSWORD",
  });
  expect(await send({ type: "UNLOCK", password: "e2e password" })).toEqual({ ok: true });
  expect(await send({ type: "REVEAL_MNEMONIC", password: "e2e password" })).toEqual({
    ok: true,
    mnemonic: created.mnemonic,
  });
});
