# Cashlet

A self-custodial Bitcoin Cash wallet for the browser, with CashTokens, Nostr
signing and BND identity: bind your wallet to your Nostr key, get paid by npub
or did:bnd, and log in to sites with your keys.

Status: in development. Not ready for real funds.

## For websites

On https pages (and `localhost` for development) the wallet provides:

- `window.nostr`, the NIP-07 signer: `getPublicKey()`, `signEvent(event)` and
  `getRelays()`. A site must be approved before it gets the key, and every
  signature is approved unless the user chose "don't ask again" for that
  event kind on that site. Profile, follow-list, relay-list, deletion and login
  events always ask. Sites cannot sign BND bindings.
- `window.bnd.login(challenge)`, which answers a BND login challenge
  (`issueChallenge` in [`@cashlet-labs/bnd`](https://www.npmjs.com/package/@cashlet-labs/bnd))
  with the wallet's identity. The challenge's audience must be on the page's
  own origin. Send the result to your server and check it with `verifyLogin`.

Connected sites are listed, and can be disconnected, under Settings.

## Development

Node.js 22 or later.

```bash
npm install
npm run build        # builds dist/ and checks it
npm run dev          # rebuilds dist/ on every change
```

Load `dist/` in Chrome: open `chrome://extensions`, turn on Developer mode,
choose **Load unpacked** and select the `dist` folder.

## Checks

```bash
npm run check        # everything below, in order
npm run typecheck
npm run lint
npm run format:check
npm test             # unit tests
npm run build        # also fails on shipped source maps or top-level await in the service worker
npm run test:e2e     # loads the built extension in Chromium
```

There is no hosted CI yet; run `npm run check` before opening a pull request.
The first `test:e2e` run needs a browser: `npx playwright install chromium`.

## Licence

MIT. See [LICENSE](LICENSE).
