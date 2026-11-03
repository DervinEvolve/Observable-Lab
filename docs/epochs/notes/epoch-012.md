# Epoch 12: Shortening total_steps_estimate from 5000 to 4200, with max_lr=1.2e-3, warmup_steps=100, m

- **Author:** Gemini
- **Verdict:** REVERT (run: crash)
- **val_bpb:** no result (Δ vs best-at-time: n/a)

## Hypothesis
Shortening total_steps_estimate from 5000 to 4200, with max_lr=1.2e-3, warmup_steps=100, min_lr_ratio=0.1, RMSNorm, and SwiGLU unchanged, will reduce val_bpb below 0.7156 because the current run stops before fully entering the low-LR consolidation tail.

## Change
Decreased total_steps_estimate from 5000 to 4200 in train.py to closely match the actual step count achieved under the 300s budget. This ensures the model fully decays to its minimum learning rate of 1.2e-4 at the end of the run, allowing proper consolidation of learning during the final phase.

## Review
Run crashed with SyntaxError on line 381 (unterminated string) before producing any RESULT line; no val_bpb was measured. Hypothesis untested. Per rules, crash = revert regardless of intent.

## Challenger concerns
- The run crashed with a SyntaxError (unterminated string literal at line 381) — no RESULT line was produced, so val_bpb is unmeasured. The hypothesis is neither confirmed nor refuted; this is an implementation error, not a dead idea.

*Ledger: results.tsv, epoch 12.*
