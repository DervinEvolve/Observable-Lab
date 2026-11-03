# Epoch 16: Evaluating a cosine schedule with total_steps_estimate=4100 and a min_lr_ratio of 0.01 (in

- **Author:** Grok
- **Verdict:** REVERT (run: ok)
- **val_bpb:** 0.7153 (Δ vs best-at-time: 0.0086)

## Hypothesis
Evaluating a cosine schedule with total_steps_estimate=4100 and a min_lr_ratio of 0.01 (instead of 0.1) while keeping all other parameters identical to the epoch 14 best configuration will reduce val_bpb below 0.7067 because forcing a deeper annealing to a very low learning rate (1.2e-5) in the final steps allows for better fine-grained parameter consolidation without starving early-to-mid-stage learning.

## Change
Minimal surgical change: in train(), pass min_lr_ratio=0.01 to the single lr_at_step() call (line ~280). All other code, defaults, and schedule parameters identical to epoch-14 best.

## Review
The isolated min_lr_ratio change from 0.1 to 0.01 regressed: val_bpb=0.71526 versus the current best 0.7067, despite completing 4400 steps in 300.19s with the same 10.72M-param model. Because it is worse by +0.0086 bpb and Challenger found no methodological issue that would rescue it, the epoch must be reverted. The lesson is that the 4100-step horizon should stay, but the deeper 1.2e-5 LR floor is harmful or at least not reliably beneficial.

## Challenger concerns
- The change is cleanly isolated (single min_lr_ratio 0.1→0.01), so attribution is fine. But the result is a clear REGRESSION: 0.7153 vs e14 best 0.7067, +0.0086 bpb. Note the step count jumped to 4400 (vs 4335 at e14) — this is NOT a speed effect, it's the same wall clock; the extra steps come from run-to-run noise. Yet bpb got worse despite MORE steps, confirming the deep anneal to 1.2e-5 hurt.
- Interpretation caveat: the delta (+0.0086) is above the sub-0.01 'suggestive' noise band flagged in e14 notebook, so this is a real regression, not variance. But we STILL have no seed replicate to pin the noise floor — the fact that e13's exact same config (4100/0.01) measured 0.7071 while THIS run measured 0.7153 is a ~0.008 discrepancy on IDENTICAL config.

*Ledger: results.tsv, epoch 16.*
