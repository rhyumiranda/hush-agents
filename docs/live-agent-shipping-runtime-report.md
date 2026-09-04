# Live Agent Shipping Runtime Report

Date: 2026-09-04

## Result

PASS: the shipping quote sample project was implemented and checked using live spawned agents instructed to load our custom profiles.

## Project

- Base repo: `work/live-agent-shipping-app`
- Candidate worktree: `work/live-agent-worktrees/flint-t01`
- Main changed file: `src/shipping.js`
- Final candidate commit: `c9876017f9416204c9e945cca171bbf6b45cfe03`
- Frozen snapshot: `SNAP-LIVE-SHIP-1`

## Agents Run

| Step | Agent | Result |
|---|---|---|
| Requirements | Fable | Produced requirement map, preserved unknowns, found ambiguous `zone` output contract. |
| Planning | Rook | Produced one safe task, worker count `1`, writable hub `src/shipping.js`. |
| Implementation | Flint | Edited only `src/shipping.js`, ran `npm test`, committed candidate. |
| Verification 1 | Puck | BLOCKED: fake packet/report digests. |
| Verification 2 | Puck | BLOCKED: digest canonicalization mismatch. |
| Verification 3 | Puck | BLOCKED: Flint report binding needed file SHA, not canonical body SHA. |
| Verification 4 | Puck | VERIFIED: integrity clean and all checks passed. |
| Alignment 1 | Vera | BLOCKED: Vera packet digest mismatch. |
| Alignment 2 | Vera | ALIGNED: all in-scope requirements matched lifted code behavior. |
| Acceptance | Hush local | Accepted after base check, Puck `VERIFIED`, and Vera `ALIGNED`. |

## Measured Requirements

| Requirement | Expected | Actual | Result |
|---|---:|---:|---|
| R-01 local standard 3kg `priceCents` | 1100 | 1100 | PASS |
| R-02 remote standard 3kg `priceCents` | 1650 | 1650 | PASS |
| R-03 remote express 3kg `priceCents` | 2850 | 2850 | PASS |
| R-04 standard `etaDays` | 5 | 5 | PASS |
| R-04 express `etaDays` | 2 | 2 | PASS |
| R-05 preserve `zone` | input zone | input zone | PASS |

## Final Code Behavior

`quoteShipping(order)` now:

- computes base price as `500 + 200 * weightKg`
- multiplies remote zone by `1.5`
- adds express surcharge `1200`
- returns ETA `2` for express and `5` otherwise
- preserves `zone`

## Issues Found And Fixed During The Run

The live agents found harness issues the deterministic runtime did not fully prove:

1. Puck rejected fake digest strings.
2. Puck rejected unsorted JSON packet hashing.
3. Puck required the Flint report binding to match the report file SHA.
4. Vera rejected its first packet digest.

Hush reissued corrected packets until Puck and Vera integrity checks passed.

## Evidence Files

- Fable requirements: `work/live-agent-evidence/fable-requirements.md`
- Flint packet: `work/live-agent-evidence/flint-packet-1.json`
- Flint report: `work/live-agent-evidence/flint-report-2.json`
- Verified Puck packet: `work/live-agent-evidence/puck-packet-4.json`
- Puck report: `work/live-agent-evidence/puck-report-4.json`
- Puck measured values: `work/live-agent-evidence/puck-independent-quoteShipping-4.json`
- Vera packet: `work/live-agent-evidence/vera-packet-2.json`

## Important Limit

The subagent tool cannot directly select `@fable`, `@rook`, `@flint`, `@puck`, or `@vera` by custom profile name. Each live subagent was explicitly told to read the matching TOML profile and obey it.

So this proves live role behavior under profile-loaded prompts. It does not yet prove native Codex profile dispatch by mention.
