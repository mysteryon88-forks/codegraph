# Evaluator key: Tolk agent A/B

**Controller/evaluator material. Keep outside every answering agent's repository/context.** This key accompanies [the protocol](tolk-agent-ab.md); no agent results exist yet. Five binary facts per task, one point each, only when supported by correct repository-relative file:line citations. A citation may cover the declaration, call or relevant import; verify against the pinned source rather than requiring one exact formatting style. Correct uncertainty is preferable to an invented edge, but does not earn a missing required fact. Any critical false target fails the answer regardless of its numeric score.

Facts were checked against pinned source and the pre-existing [Webdom](../../scripts/tolk-expectations/webdom.json) / [Acton](../../scripts/tolk-expectations/acton.json) source-only oracles. Express was read directly at v5.1.0 commit `cd7d4397c398a3f3ecadeaf9ef6ac1377bd414c4`. These are facts/identifiers, not vendored Webdom contract bodies. Do not grade from whichever edges CodeGraph happened to return.

## W1 — NFT notification

1. Entrypoint is `onInternalMessage` in `contracts/marketplace/contract.tolk`.
2. It calls `handleNftOwnershipAssigned` in `contracts/marketplace/message_handlers.tolk` for the NFT notification.
3. That handler calls `checkEnoughGas` in `contracts/marketplace/utils.tolk`.
4. Availability follows the actual local imports, resolved relative to the respective importing files, not a project-wide short-name search.
5. The chain stays in marketplace Tolk source; unrelated contracts' `onInternalMessage` and TypeScript wrappers are not its static callees.

## W2 — Domain swap

1. Caller is `onInternalMessage`, `contracts/domain_swap/contract.tolk:15`.
2. The right-side completion path calls `completeDeal` from `contracts/domain_swap/utils.tolk` (call sites in the contract at96 and174).
3. The importing file has local `import "utils"` at line8; the helper is available without an `export` keyword.
4. Completion is associated with the right side having supplied the required payment/domains; cite the actual completion branch rather than claiming every message completes a deal.
5. The external-message path uses `returnDomains`, not a fabricated direct external→completeDeal edge; another contract's same-named handler is unrelated.

## W3 — Sale reserve

1. External entrypoint is `onExternalMessage` in `contracts/fix_price_sales/ton_simple_sale/contract.tolk` (declaration at344).
2. It calls that file's `getRequiredReserve` (declaration at42).
3. This helper calls `saleStorageReserve`, declared in the sibling `constants.tolk:20`.
4. It also calls `autoRenewLockPerIter` in that sibling file (declaration at37); this is a function even though the filename is constants.
5. `import "constants"` supplies those local helpers; the answer neither substitutes another sale's declarations nor invents cross-contract/TS call edges.

## M1 — Recursive deployment

1. Caller is `onInternalMessage` in `apps/localton/load-test/contracts/RecursiveDeployer.tolk:67`.
2. The Expand branch calls the same file's `expandOnce` (call at70).
3. `expandOnce` calls the same file's `deployChild` (declaration at49).
4. `expandOnce` uses `Storage.load` and `Storage.save` declared in `apps/localton/load-test/contracts/types.tolk`, with receiver owner `Storage`.
5. The relevant storage import is local `types`; Counter/Jetton template entrypoints and their separate storage declarations do not belong to this chain.

## M2 — Counter storage

1. Caller is `onInternalMessage`, `src/commands/new/templates/counter/contracts/Counter.tolk:16`.
2. It uses `Storage.load` from the sibling `types.tolk:13`.
3. Update branches call `storage.save()`, resolving to receiver method `Storage.save` in sibling `types.tolk:17`.
4. `import "types"` at line1 is the local dependency; `Storage` is the receiver owner, not an enclosing lexical struct function body.
5. The answer keeps the Counter receiver/handler separate from RecursiveDeployer and Jetton templates with overlapping short names.

## M3 — Jetton transfer amount

1. Caller is `onInternalMessage`, `src/commands/new/templates/jetton/contracts/JettonMinter.tolk:44`.
2. It calls `checkAmountIsEnoughToTransfer` in sibling `fees-management.tolk` (call at117).
3. That function is declared in `fees-management.tolk:74` and calls `calcMinimalTransferAmount` at75.
4. `calcMinimalTransferAmount` is declared in that file at50; Minter's `import "fees-management"` at line3 supplies the first helper.
5. The separate Wallet entrypoint can use a common helper, but is not a static call hop from this Minter entrypoint.

## Express control

Primary sources: [createApplication](https://github.com/expressjs/express/blob/cd7d4397c398a3f3ecadeaf9ef6ac1377bd414c4/lib/express.js#L36), [application](https://github.com/expressjs/express/blob/cd7d4397c398a3f3ecadeaf9ef6ac1377bd414c4/lib/application.js). Router dependency internals and Node HTTP internals are outside this source snapshot; declaring that boundary is correct, fabricating a local implementation is not.

### C1 — Request dispatch

1. `createApplication`, `lib/express.js:36`, creates a callable `app` that forwards `(req,res,next)` to `app.handle`.
2. Application behavior comes from the prototype mixed into `app`; the returned application is this callable object.
3. `app.handle`, `lib/application.js:152`, chooses the provided callback or `finalhandler` as `done`.
4. It links request/response and installs `this.request` / `this.response` prototypes, also initializing response locals if missing.
5. It invokes `this.router.handle(req,res,done)` at177; the external router package's implementation is not supplied by a same-named Express file.

### C2 — Child mounting

1. `app.use`, `lib/application.js:190`, distinguishes an optional path and flattens middleware arguments.
2. Ordinary middleware goes to `router.use(path,fn)`; the child-app branch checks for app-like `handle` and `set` members.
3. Child registration sets `mountpath` and `parent`, and registers a `mounted_app` closure using `router.use`.
4. The closure calls `fn.handle`; its callback restores request/response prototypes using the original app and forwards `next(err)`.
5. Mount registration emits the child's `mount` event with its parent; do not substitute the ordinary-middleware path for this lifecycle.

### C3 — Listening

1. `app.listen`, `lib/application.js:598`, creates a Node HTTP server with the application as request listener.
2. It copies the supplied arguments into an array.
3. A trailing function is wrapped with `once` and also registered for a one-shot server error event.
4. It forwards the arguments using `server.listen.apply(server,args)` and returns that result.
5. `http.createServer` / server listening cross into Node runtime; this is not `app.handle` directly creating a socket or implementing HTTP itself.

## Scoring and report form

Grade anonymized final answers before looking at arm/tool/time labels. Record all five booleans, citations, missing facts and critical errors. Then reveal the arm and attach metrics. Do not change this key after observing agent answers; version and hash any correction, retain earlier attempts, and disclose the reason.

| Task | Repeat | Arm | Valid / reason | Score /5 | Critical error | Time | Tools | Read/Grep | Bash equivalents | Explore/node | Cost/mode | Occupancy/sufficiency/allocation |
|---|---|---|---|---|---|---|---|---|---|---|---|
| W1 |1|without|NOT RUN|—|—|—|—|—|—|—|—|—|

Add every planned and invalid/spent attempt. Report per-task medians/ranges, correctness/completion rates and the two paired time deltas. Keep budget/timeout failures visible; speed comparisons require paired correct completions. Control rows use baseline/new labels, both CodeGraph-on. State pilot-only, medium extension, control and large-corpus gate separately. These are planned criteria, not measured improvements.
