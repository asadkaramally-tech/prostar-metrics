# PSM Metrics preservation record — 2026-08-28

This is the first local preservation copy created before branch promotion, source import, repository cleanup, or production work. It is **not yet sufficient for deletion**: the binary payloads need a second verified copy in owner-approved protected storage.

The binary payloads are deliberately ignored by Git because they may contain internal design or operational material. Do not publish them to the currently public `prostar-metrics` repository.

No `.env.local`, Azure CLI session/profile file, credential value, or production secret was copied into this folder.

## Source candidates

| Label | Original path | HEAD | State |
|---|---|---|---|
| `candidate-2026-07-27` | `/Users/asadkaramally/Documents/Codex/2026-07-27/prostar-metrics` | `7571b13bdfa155693cddf2f284c2275a9c11df01` | Tracks origin redesign branch; modified generated `next-env.d.ts` and install-churn `package-lock.json`; no nonignored untracked files |
| `candidate-restyle` | `/Users/asadkaramally/Documents/Codex/2026-07-20/prostar-metrics-restyle` | `ea364477ba38bbb6ca524b13fc3dc296bb7943a0` | 40 commits behind; modified Materials work; untracked design/components/store work |
| `candidate-i-work` | `/Users/asadkaramally/Documents/Codex/2026-07-20/i/work/prostar-metrics` | `7571b13bdfa155693cddf2f284c2275a9c11df01` | Same tracked baseline; modified CSS/nav/material store; untracked design/API/prototype work; unique ignored release evidence |
| `release-1d981b5` | `/Users/asadkaramally/Documents/Codex/2026-07-20/i/work/prostar-metrics-release-1d981b5` | `1d981b592ee222f10eefd4ee49e4738d2f224522` | Clean detached worktree, one commit behind strongest candidate |

## Preserved overlays

Each patch is `git diff --binary HEAD`, gzip-compressed. Each untracked archive contains only `git ls-files --others --exclude-standard`; ignored files are excluded.

| Artifact | SHA-256 |
|---|---|
| `overlays/candidate-2026-07-27.patch.gz` | `c18ecde3975a60bf1501ecf20b26652291df72eaaa1a10ee46cd32f0a3432b84` |
| `overlays/candidate-2026-07-27-untracked.tar.gz` | `35c24929c3c50243bd3b0ff7aacf02648765fefdae73d63505899e6ae9a98273` |
| `overlays/candidate-restyle.patch.gz` | `4be65a26cc4a964610b3485b6f4cd4dcbc9c4c7168bfcaadcbe179175388f820` |
| `overlays/candidate-restyle-untracked.tar.gz` | `a5465b98d1bfc46eaea4ebbcb8c6cc1b183ba3561cfc181ef4abdae9e10f1616` |
| `overlays/candidate-i-work.patch.gz` | `1fc81ad7cc5a712309ec7c52643a5c89c47ce8ad967fe96918bb434a83a86c6e` |
| `overlays/candidate-i-work-untracked.tar.gz` | `89f1e77a83b2711c284a8243a4b6bd1c1f5214f350a314bd6209f1b8af98b107` |

All three gzip patch streams passed `gzip -t` after creation.

## Preserved unreachable stash structures

The following Git objects were unreachable from refs. A full-tree archive was produced for each commit so garbage collection cannot erase its content before disposition. The three-object groups are Git stash structures: WIP merge, index, and untracked tree.

### Restyle checkout

| Commit | Meaning | Archive SHA-256 |
|---|---|---|
| `f596837bc8d1c4f7adfc57dc64a58c59637f2946` | WIP merge; approved-redesign shared layer | `3bc7104f8c8ecd55d4297e48ddb6efb7168e3b7b75f550fdf73b44fd981f3500` |
| `71b8e3a7d5a2a588c11f75e6b5a8f4a395193dda` | Staged/index side | `7d781237007dc1238cd552502c595f3aa345815dc8e5dbda6779b2df3dafc15e` |
| `d8f5f3f080764ea8bd58643b579da478f62130ac` | Untracked side | `0c211b06b95ce1a84bb1aae2a4ad619821c9e1f3720bae128f308089e76565a0` |

### `i/work` checkout

| Commit | Meaning | Archive SHA-256 |
|---|---|---|
| `66de3bec11c0bfd94215ce540fe913ce11a14052` | WIP merge; nested queue coalescing pending approval | `8b732852ec53de7e4e059ea4a6634d281c7789230bae190ba6c9b7ede777ee0c` |
| `5bcebc41cf6aadb9e7d639727bc5515c0ecebcad` | Staged/index side | `e3d07ee0b31406fdb7c12dc3a9ffe81efef67aaa3b177c203a633ac751ef15ca` |
| `d7f7a16914fcb6c35a3df8a3bcb11192121f6133` | Untracked side | `7eeb4305eaf58aed898b020a816d537af34d61041f8f8a2b3475048294adc974` |

## Unique ignored evidence left in place

Raw evidence was hashed but not copied because it can include internal deployment metadata. It remains in the original `candidate-i-work` checkout.

- `docs/prostar-metrics/verification/deployment-manifest.json`
  - SHA-256: `e358e29fedb33f09087a539b01442a6f00f00a44e2fc1b214fe1dec8c8a9f8b6`
- `.work/deploy-prod-resume/`
  - 26 JSON checkpoint files
  - Individual hashes: [`evidence-hashes.md`](./evidence-hashes.md)
- `.work/azure/`
  - Deliberately not copied or inspected for values; contains local Azure session/configuration state

## Local credential-file inventory

Ignored `.env.local` files exist in the July 27 and restyle checkouts. Contents were not read or copied. Before removal, verify all required credentials are recoverable from Key Vault or the owner-approved secret source; rotate only if an exposure scan proves the need and the owner authorizes it.

## Completion boundary

This preservation step becomes complete only when:

1. Every binary artifact above has a second copy in owner-approved protected storage.
2. The second copy is independently hashed and matches this record.
3. The raw deployment manifest and relevant resume receipts have a protected copy or an approved sanitized substitute.
4. Recovery of one patch, one untracked archive, and one unreachable archive has been sampled.
