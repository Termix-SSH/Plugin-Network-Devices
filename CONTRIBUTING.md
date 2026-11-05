# Contributing to Network Devices

## Development

```bash
npm run build      # build into dist/
npm run test       # run this plugin's tests
npm run typecheck  # type-check this plugin
npm run validate   # check manifest.json
npm run migrations # write migrations after changing src/backend/tables.ts
npm run pack       # pack dist/ into a .tmxplug
npm run format     # format the code with Prettier
```

## Adding a device type

A device type is one file in `src/backend/drivers/` that implements `Driver` from `types.ts`, added to `drivers/index.ts`. It lists the keys it needs, what it can do (`features`), and reads the device with `probe`, `ports`, `clients` and `neighbors`. Web APIs go through `request` in `web.ts`, which only allows the device's own address. SNMP goes through the small client in `snmp-client.ts` so tests can fake it.

## Docs

The docs for this plugin are in [docs/](docs/), and `docs` in `manifest.json` links to them. Settings, permissions, services, environment variables and the API reference are made from `manifest.json` and the `@openapi` comments in the code, so keep those up to date instead of writing them by hand. See [writing docs](https://docs.termix.site/develop/docs).
