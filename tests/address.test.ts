import { describe, expect, it } from "vitest";
import { parseDestination, parsePaymentRequest } from "../src/wallet/address";
import { formatBch, parseBch } from "../src/wallet/amount";
import { HdWallet } from "../src/wallet/hd";

const wallet = HdWallet.fromMnemonic(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const chipnet = wallet.address(0, 0, "chipnet");
const mainnet = wallet.address(0, 0, "mainnet");

describe("parseBch and formatBch", () => {
  it("parses exactly, without floating point", () => {
    expect(parseBch("0.01")).toBe(1_000_000);
    expect(parseBch("0.00000001")).toBe(1);
    expect(parseBch("21000000")).toBe(21_000_000 * 1e8);
    expect(parseBch("0.1")).toBe(10_000_000);
  });

  it("refuses odd forms", () => {
    for (const bad of [
      "",
      "-1",
      "1e3",
      "0x10",
      "1,5",
      "0.123456789",
      "21000000.00000001",
      ".5",
      "1.",
    ]) {
      expect(() => parseBch(bad)).toThrow(RangeError);
    }
  });

  it("formats without trailing zeros", () => {
    expect(formatBch(1_000_000)).toBe("0.01");
    expect(formatBch(123_456_789)).toBe("1.23456789");
    expect(formatBch(0)).toBe("0");
  });
});

describe("parseDestination", () => {
  it("accepts the wallet's network, with or without the prefix, in either case", () => {
    expect(parseDestination(chipnet, "chipnet").address).toBe(chipnet);
    expect(parseDestination(chipnet.split(":")[1]!, "chipnet").address).toBe(chipnet);
    expect(parseDestination(chipnet.toUpperCase(), "chipnet").address).toBe(chipnet);
    expect(parseDestination(wallet.address(0, 0, "chipnet", true), "chipnet")).toMatchObject({
      tokenAware: true,
      type: "p2pkh",
    });
  });

  it("refuses the other network, mixed case and garbage", () => {
    expect(() => parseDestination(mainnet, "chipnet")).toThrow("mainnet address");
    expect(() => parseDestination(chipnet, "mainnet")).toThrow("test network address");
    expect(() => parseDestination("bchtest:qQyx", "chipnet")).toThrow("lowercase or all uppercase");
    expect(() => parseDestination("bchtest:qqqq", "chipnet")).toThrow("not a valid");
    expect(() => parseDestination("bitcoin:1abc", "chipnet")).toThrow("not a Bitcoin Cash address");
  });
});

describe("parsePaymentRequest", () => {
  it("reads address, amount, label and message", () => {
    const request = parsePaymentRequest(
      `${chipnet}?amount=0.015&label=Shop&message=Order%2042`,
      "chipnet",
    );
    expect(request).toMatchObject({ amount: 1_500_000, label: "Shop", message: "Order 42" });
    expect(request.destination.address).toBe(chipnet);
    expect(parsePaymentRequest(chipnet, "chipnet").amount).toBeNull();
  });

  it("refuses required extensions it does not understand, repeated keys and bad amounts", () => {
    expect(() => parsePaymentRequest(`${chipnet}?req-future=1`, "chipnet")).toThrow("req-future");
    expect(() => parsePaymentRequest(`${chipnet}?amount=1&amount=2`, "chipnet")).toThrow("repeats");
    expect(() => parsePaymentRequest(`${chipnet}?amount=1e3`, "chipnet")).toThrow(RangeError);
  });
});
