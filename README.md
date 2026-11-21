# Cashlet

A self-custodial Bitcoin Cash wallet for the browser, with CashTokens, Nostr
signing and BND identity: bind your wallet to your Nostr key, get paid by npub
or did:bnd, and log in to sites with your keys.

Status: in development. Not ready for real funds.

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
