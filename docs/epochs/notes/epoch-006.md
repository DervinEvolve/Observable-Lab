# Epoch 6: Raising max_lr from 1.2e-3 to 1.8e-3 (5000-step cosine horizon, 100-step warmup) will lowe

- **Author:** Gemini
- **Verdict:** REVERT (run: ok)
- **val_bpb:** 0.7234 (Δ vs best-at-time: -0.0002)

## Hypothesis
Raising max_lr from 1.2e-3 to 1.8e-3 (5000-step cosine horizon, 100-step warmup) will lower val_bpb below 0.7236 on TinyStories because the cleaner data distribution permits a more aggressive early LR without the collapse seen at 2.4e-3 on enwik8.

## Change
Changed max_lr from 1.2e-3 to 1.8e-3 inside the train function. This implements the bisecting LR sweep on the new TinyStories dataset as proposed by the Planner.

## Review
The run completed normally, but the measured gain is tiny: 0.723446 vs current best 0.7236, an improvement of only about 0.00015 bpb with essentially unchanged steps/VRAM. The Challenger's variance warning is credible; this is below the resolution where a single 300s stochastic run can confidently establish a new baseline. Under the stated keep rule, the confound means we should not merge this LR change.

## Challenger concerns
- Single-run noise: the observed val_bpb difference (0.00015) is far smaller than the likely run-to-run variance of the evaluation harness and training stochasticity. Without replicate runs, we cannot distinguish a true zero effect from a small improvement or degradation.

*Ledger: results.tsv, epoch 6.*
