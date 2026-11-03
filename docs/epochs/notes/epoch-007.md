# Epoch 7: Replacing LayerNorm with RMSNorm and using a small epsilon of 1e-5 will lower val_bpb belo

- **Author:** DeepSeek-V4
- **Verdict:** KEEP (run: ok)
- **val_bpb:** 0.7223 (Δ vs best-at-time: -0.0013)

## Hypothesis
Replacing LayerNorm with RMSNorm and using a small epsilon of 1e-5 will lower val_bpb below 0.7200 because RMSNorm is computationally cheaper (allowing more training steps under the 300s budget) and stabilizes the residual stream by eliminating mean-centering scale shifts.

## Change
Defined a new RMSNorm class (root-mean-square normalization, eps=1e-5, learnable scale, no bias). Replaced all LayerNorm instances in Block (ln_1, ln_2) and GPT (ln_f) with RMSNorm. Updated _init_weights to initialize RMSNorm weight to ones. No other hyperparameters or training logic changed.

## Review
RMSNorm measured 0.72226 vs baseline 0.7236 — a real 0.0014 improvement, ~7x larger than the sub-1e-4 LR-tweak noise the panel rejected in e6, and it cleared the ~1e-4 credibility bar Reviewer set. Steps rose 4100→4164 confirming the cheaper-norm throughput gain, VRAM/params essentially unchanged (3160 MB, 10.72M). It missed the aspirational 0.7200 target, but the decision standard is 'improved on best', not the Planner's stretch goal. No cheating or leakage flagged.

## Challenger concerns
- The run did not meet the hypothesis' stated success threshold of val_bpb below 0.7200, even though it beat the current baseline.
- The causal mechanism is partly confounded: RMSNorm changed both normalization behavior and throughput/parameter count.
- The effect size is modest and based on one run, so variance remains a concern.
- No obvious metric gaming, validation leakage, evaluation tampering, or budget violation is visible from the described change and RESULT line.

*Ledger: results.tsv, epoch 7.*
