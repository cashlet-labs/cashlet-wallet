import { describe, expect, it } from "vitest";
import { WalletService, type Connection } from "../src/background/wallet-service";
import { parseRequest } from "../src/shared/messages";
import { formatFiat, parseRates, RATE_TTL_MS, RATE_URLS, RateService } from "../src/wallet/rates";
import { MemoryKeyValue, WalletSession } from "../src/wallet/session";
import { MemoryStore } from "../src/wallet/store";

const [BITPAY, COINBASE] = RATE_URLS;

const bitpay = (rows: unknown) => rows;
const coinbase = (rates: Record<string, unknown>) => ({ data: { currency: "BCH", rates } });

/** A fetch that answers from a table and counts calls. A missing or null entry fails. */
function fakeFetch(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const body = answers[url];
    if (body === undefined || body === null) throw new Error("offline");
    return { ok: true, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const GOOD = bitpay([
  { code: "USD", rate: 200 },
  { code: "EUR", rate: 180 },
  { code: "XXX", rate: 5 },
  { code: "GBP", rate: -3 },
  { code: "JPY", rate: "nope" },
  { code: "KES", rate: Infinity },
]);

describe("parseRates", () => {
  it("keeps only offered currencies with sane positive numbers", () => {
    expect(parseRates(BITPAY, GOOD)).toEqual({ USD: 200, EUR: 180 });
    expect(parseRates(COINBASE, coinbase({ USD: "201.5", NGN: "270000", EUR: "0" }))).toEqual({
      USD: 201.5,
      NGN: 270_000,
    });
  });

  it("refuses a response without a usable USD rate", () => {
    expect(() => parseRates(BITPAY, [{ code: "EUR", rate: 1 }])).toThrow();
    expect(() => parseRates(BITPAY, [{ code: "USD", rate: 1e12 }])).toThrow();
    expect(() => parseRates(BITPAY, { not: "a list" })).toThrow();
    expect(() =>
      parseRates(COINBASE, { data: { currency: "BTC", rates: { USD: "5" } } }),
    ).toThrow();
    expect(() => parseRates(COINBASE, null)).toThrow();
  });
});

describe("RateService", () => {
  const make = (answers: Record<string, unknown>) => {
    const net = fakeFetch(answers);
    const clock = { now: 1_000_000 };
    const settings = new MemoryKeyValue();
    const service = new RateService({ settings, fetch: net.impl, now: () => clock.now });
    return { service, net, clock, settings };
  };

  it("defaults to USD and stores the choice", async () => {
    const { service } = make({});
    expect(await service.choice()).toBe("USD");
    await service.setChoice("OFF");
    expect(await service.choice()).toBe("OFF");
  });

  it("caches a rate for five minutes, then fetches again", async () => {
    const { service, net, clock } = make({ [BITPAY]: GOOD });
    expect(await service.rate("EUR")).toEqual({ rate: 180, fetchedAt: 1_000_000 });
    await service.rate("USD");
    expect(net.calls).toHaveLength(1);
    clock.now += RATE_TTL_MS + 1;
    await service.rate("USD");
    expect(net.calls).toHaveLength(2);
  });

  it("fails over to the second source, and gives null when both fail", async () => {
    const second = make({ [COINBASE]: coinbase({ USD: "150" }) });
    expect(await second.service.rate("USD")).toMatchObject({ rate: 150 });
    expect(second.net.calls).toEqual([BITPAY, COINBASE]);
    const none = make({});
    expect(await none.service.rate("USD")).toEqual({ rate: null, fetchedAt: null });
  });

  it("falls back to a rate under an hour old, but not an older one", async () => {
    const { service, settings } = make({ [BITPAY]: GOOD });
    await service.rate("USD");
    const later = (ms: number) =>
      new RateService({ settings, fetch: fakeFetch({}).impl, now: () => 1_000_000 + ms });
    expect(await later(20 * 60_000).rate("USD")).toMatchObject({ rate: 200 });
    expect(await later(2 * 3_600_000).rate("USD")).toEqual({ rate: null, fetchedAt: null });
  });

  it("shares one fetch between simultaneous requests", async () => {
    const { service, net } = make({ [BITPAY]: GOOD });
    await Promise.all([service.rate("USD"), service.rate("EUR")]);
    expect(net.calls).toHaveLength(1);
  });
});

describe("formatFiat", () => {
  it("formats with the currency's own symbol and digits", () => {
    expect(formatFiat(100_000_000, 200, "USD")).toContain("200.00");
    expect(formatFiat(50_000_000, 31_000, "JPY")).toMatch(/15,?500/);
    expect(formatFiat(0, 200, "USD")).toContain("0.00");
  });

  it("shows tiny amounts as below one cent", () => {
    expect(formatFiat(100, 200, "USD")).toMatch(/^< .*0\.01$/);
  });
});

describe("rate messages", () => {
  it("validates GET_RATE and SET_FIAT", () => {
    expect(parseRequest({ type: "GET_RATE" })).toEqual({ type: "GET_RATE" });
    expect(parseRequest({ type: "GET_RATE", extra: 1 })).toHaveProperty("error");
    expect(parseRequest({ type: "SET_FIAT", currency: "KES" })).toEqual({
      type: "SET_FIAT",
      currency: "KES",
    });
    expect(parseRequest({ type: "SET_FIAT", currency: "OFF" })).toMatchObject({ type: "SET_FIAT" });
    for (const currency of ["usd", "XXX", "", 5, null, "https://x"]) {
      expect(parseRequest({ type: "SET_FIAT", currency })).toHaveProperty("error");
    }
    expect(parseRequest({ type: "SET_FIAT" })).toHaveProperty("error");
  });
});

class EmptyConnection implements Connection {
  currentServer = "wss://fake.test";
  async request<T>(method: string): Promise<T> {
    return (method === "blockchain.relayfee" ? 0.00001 : []) as T;
  }
  async subscribe(): Promise<string | null> {
    return null;
  }
  onStatus(): () => void {
    return () => undefined;
  }
  async broadcast(_hex: string, txid: string): Promise<string> {
    return txid;
  }
  health() {
    return [];
  }
  close(): void {}
}

async function walletOn(network: "mainnet" | "chipnet", answers: Record<string, unknown>) {
  const net = fakeFetch(answers);
  const service = new WalletService({
    session: new WalletSession(new MemoryKeyValue(), { iterations: 1_000 }),
    settings: new MemoryKeyValue(),
    connect: () => new EmptyConnection(),
    openStore: async () => new MemoryStore(),
    fetch: net.impl,
  });
  await service.handle({
    type: "IMPORT_WALLET",
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    password: "correct horse",
    network,
  });
  return { service, net };
}

describe("WalletService rates", () => {
  it("answers GET_RATE on mainnet, and honours Off", async () => {
    const { service } = await walletOn("mainnet", { [BITPAY]: GOOD });
    expect(await service.handle({ type: "GET_RATE" })).toMatchObject({
      ok: true,
      currency: "USD",
      rate: 200,
      testCoins: false,
    });
    await service.handle({ type: "SET_FIAT", currency: "EUR" });
    expect(await service.handle({ type: "GET_RATE" })).toMatchObject({
      currency: "EUR",
      rate: 180,
    });
    await service.handle({ type: "SET_FIAT", currency: "OFF" });
    expect(await service.handle({ type: "GET_RATE" })).toMatchObject({
      currency: "OFF",
      rate: null,
    });
  });

  it("never fetches for a chipnet wallet", async () => {
    const { service, net } = await walletOn("chipnet", { [BITPAY]: GOOD });
    expect(await service.handle({ type: "GET_RATE" })).toMatchObject({
      ok: true,
      rate: null,
      testCoins: true,
    });
    expect(net.calls).toEqual([]);
  });

  it("reports no rate, not an error, when the sources are down", async () => {
    const { service } = await walletOn("mainnet", {});
    expect(await service.handle({ type: "GET_RATE" })).toMatchObject({ ok: true, rate: null });
  });
});
