# mend

[![Bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/eziebatozai/mend-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/eziebatozai/mend-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is a zero-dependency Node 22 command-line patch tool implementing `SPEC.md` for all four AI edit formats: unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls.

## Usage

```bash
node main.ts [--format=auto|unified|search-replace|v4a|json] [--check] [--strict] [PATCH]
```

## Testing

Run the practice checks from the kit:

```bash
node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
```

## License

MIT (`SPDX-License-Identifier: MIT`).
