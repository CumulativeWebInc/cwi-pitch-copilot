# KILL-RULE-LOG.md — cwi-pitch-copilot

**Lane:** PRODUCT-BACKLOG #19 (backlog-clear operation, builder lane B3).
**Trial owner:** `agent:CWI_Radio` — Radio & Playlists department.
**Trial terms:** 30-day trial with receipts. Count drafts + sends (drafts via `--log receipts.jsonl`; sends logged manually by the human sender, since the tool never sends).

## Named result
A working internal tool for Radio & Playlists that drafts playlist pitches with verified claims embedded (placement history, evidence tiers, PRO/rights clearance status from cue sheets) pulled from the CWI catalog API. A human approves every outbound pitch; Black's exact-copy gate for his name is preserved in the tool's mandatory footer.

## Measurement
Pitches **drafted** (receipts.jsonl) AND **sent** (human send log) with embedded claims; reply rate vs. baseline once data exists.

## Kill rule
**<10 pitches sent with embedded claims in 60 days → kill the lane.**

## Log

| Date | Event | Note |
|------|-------|------|
| 2026-09-19 | Built + deployed | v1.0.0. 21/21 tests green. Live docs page verified 200. Trial owner `agent:CWI_Radio` begins 30-day receipt collection. |
| (pending) | Trial checkpoint 50% | 2026-10-04 — CWI_Radio reviews draft/send counts; process changes if behind. |
| (pending) | Trial checkpoint 75% | 2026-10-19 — same. |
| (pending) | Kill verdict | 2026-11-18 — <10 sends with embedded claims → kill + archive; ≥10 → lane continues. |

## Intervention checkpoints (standing doctrine — the in-between)
Checkpoints at 50% and 75% of the 60-day window. If sends lag, modify the process: different curator lists, different pitch angles, different track picks — measure, re-execute. Loops close by results, not expiry.
