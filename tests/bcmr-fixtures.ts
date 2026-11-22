/** A BCMR OP_RETURN output script. */
export function bcmrScript(hashHex: string, uris: string[]): Uint8Array {
  const text = new TextEncoder();
  const push = (bytes: Uint8Array) => [bytes.length, ...bytes];
  return Uint8Array.from([
    0x6a,
    ...push(text.encode("BCMR")),
    ...push(Uint8Array.from(hashHex.match(/../g)!.map((b) => parseInt(b, 16)))),
    ...uris.flatMap((uri) => push(text.encode(uri))),
  ]);
}
